import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { replayEvents } from '../src/replay.js';
import { insertEvent, listEvents } from '../src/repository.js';
import { removeTempDir } from './temp.js';

const SESSION = 'sessao-replay';
let dir: string;
let db: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-replay-'));
  db = openDatabase(join(dir, 'data.db'));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

/** Grava `count` eventos de texto na sessão e devolve os seqs gravados, em ordem. */
function seed(count: number): number[] {
  const seqs: number[] = [];
  for (let i = 0; i < count; i++) {
    seqs.push(
      insertEvent(db, {
        sessionId: SESSION,
        ts: i,
        kind: 'agent_message_chunk',
        payload: JSON.stringify({ kind: 'agent_message_chunk', text: `chunk ${i}` }),
      }),
    );
  }
  return seqs;
}

describe('replay de eventos com background (subagentes e segundo plano)', () => {
  // Linhas gravadas como o daemon grava: payload JSON sem seq/sessionId/ts. Dados sintéticos.
  const agentCall = {
    kind: 'tool_call',
    toolCallId: 'agent-1',
    title: 'Agent',
    content: [],
    locations: [],
    status: 'pending',
    toolName: 'Agent',
    background: {
      kind: 'subagent',
      state: 'running',
      label: 'Revisar o parser',
      agentType: 'Explore',
      jobs: [{ id: 'thread-1', label: 'spawnAgent', status: 'running' }],
    },
  };
  const agentDone = {
    kind: 'tool_call_update',
    toolCallId: 'agent-1',
    status: 'completed',
    toolName: 'Agent',
    background: { kind: 'subagent', state: 'completed', label: 'Revisar o parser', agentType: 'Explore' },
  };
  const oldUpdate = { kind: 'tool_call_update', toolCallId: 'call-old', status: 'completed' };

  it('replay e listagem (GET events) devolvem parentToolCallId, toolName e background; evento antigo sai igual', async () => {
    const payloads = [agentCall, agentDone, oldUpdate];
    const seqs = payloads.map((payload, i) =>
      insertEvent(db, { sessionId: SESSION, ts: i, kind: payload.kind, payload: JSON.stringify(payload) }),
    );
    const child = insertEvent(db, {
      sessionId: SESSION,
      ts: 9,
      kind: 'tool_call',
      payload: JSON.stringify({ kind: 'tool_call', toolCallId: 'read-9', title: 'Read', content: [], locations: [], parentToolCallId: 'agent-1' }),
    });

    const delivered: SessionEvent[] = [];
    await replayEvents(db, SESSION, 0, (event) => delivered.push(event), {
      isActive: () => true,
      batchSize: 200,
      yieldToLoop: async () => undefined,
    });
    const listed = listEvents(db, SESSION, 0, 50);

    const expectedReplay = [
      { ...agentCall, seq: seqs[0], sessionId: SESSION, ts: 0 },
      { ...agentDone, seq: seqs[1], sessionId: SESSION, ts: 1 },
      { ...oldUpdate, seq: seqs[2], sessionId: SESSION, ts: 2 },
      { kind: 'tool_call', toolCallId: 'read-9', title: 'Read', content: [], locations: [], parentToolCallId: 'agent-1', seq: child, sessionId: SESSION, ts: 9 },
    ];
    expect(delivered).toEqual(expectedReplay);
    expect(listed).toEqual(expectedReplay);
    expect(delivered[2]).not.toHaveProperty('background');
    expect(delivered[2]).not.toHaveProperty('toolName');
  });
});

describe('replayEvents', () => {
  it('entrega tudo em ordem, em lotes de 200, cedendo o event loop depois de cada lote', async () => {
    const seqs = seed(450);
    const delivered: number[] = [];
    let yields = 0;

    const last = await replayEvents(db, SESSION, 0, (event: SessionEvent) => delivered.push(event.seq), {
      isActive: () => true,
      batchSize: 200,
      yieldToLoop: async () => {
        yields += 1;
      },
    });

    expect(delivered).toEqual(seqs);
    expect(last).toBe(seqs[seqs.length - 1]);
    expect(yields).toBe(3);
  });

  it('afterSeq pula eventos já entregues e sem eventos devolve o próprio afterSeq', async () => {
    const seqs = seed(5);
    const delivered: number[] = [];
    const options = { isActive: () => true, batchSize: 200, yieldToLoop: async () => undefined };

    const last = await replayEvents(db, SESSION, seqs[2] ?? 0, (event) => delivered.push(event.seq), options);
    expect(delivered).toEqual(seqs.slice(3));
    expect(last).toBe(seqs[4]);

    expect(await replayEvents(db, 'outra-sessao', 7, () => undefined, options)).toBe(7);
  });

  it('para no meio quando a inscrição deixa de estar ativa', async () => {
    seed(450);
    const delivered: number[] = [];
    let active = true;

    await replayEvents(db, SESSION, 0, (event) => {
      delivered.push(event.seq);
      if (delivered.length === 200) active = false;
    }, {
      isActive: () => active,
      batchSize: 200,
      yieldToLoop: async () => undefined,
    });

    expect(delivered).toHaveLength(200);
  });
});
