import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSchema, type AgentConfig, type Session, type SessionEvent } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, createSession, fakeAgent, isEvent, listen, pairToken, WsTestClient } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-par-')));
  workspace = join(base, 'projeto');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach do vitest roda em pilha, então este roda por último
// (depois que os daemons já mataram os agentes, que mantêm o cwd dentro do workspace).
const env = setupDaemonTests();

async function start(): Promise<TestDaemon> {
  const agents: Record<string, AgentConfig> = { fake: fakeAgent() };
  return env.start({ config: { allowedRoots: [base], agents } });
}

async function workspaceId(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

/** Duas sessões fake vivas no mesmo workspace (dois processos de agente), com um WS inscrito nas duas. */
async function twoSessions(): Promise<{ daemon: TestDaemon; a: Session; b: Session; client: WsTestClient }> {
  const daemon = await start();
  const id = await workspaceId(daemon);
  const a = await createSession(daemon, { workspaceId: id, agent: 'fake' });
  const b = await createSession(daemon, { workspaceId: id, agent: 'fake' });
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  for (const session of [a, b]) client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.sync();
  return { daemon, a, b, client };
}

/**
 * Espera o turn_end de todas as sessões. Não usa uma espera por sessão: o waitFor do cliente avança um cursor,
 * então um turn_end que chegou antes da espera seria perdido. Confere o histórico inteiro de mensagens.
 */
async function untilTurnEnded(client: WsTestClient, sessionIds: readonly string[]): Promise<void> {
  const ended = (id: string): boolean =>
    client.messages.some((message) => message.type === 'event' && message.event.sessionId === id && message.event.kind === 'turn_end');
  while (!sessionIds.every(ended)) {
    await client.waitFor((message) => message.type === 'event' && message.event.kind === 'turn_end');
  }
}

function chunksOf(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => (event.kind === 'agent_message_chunk' ? [event.text] : []));
}

describe('duas sessões vivas no mesmo workspace', () => {
  it('prompts simultâneos: cada sessão recebe só o seu texto e os eventos não se misturam', async () => {
    const { a, b, client, daemon } = await twoSessions();

    client.send({ type: 'prompt', sessionId: a.id, text: 'alpha' });
    client.send({ type: 'prompt', sessionId: b.id, text: 'beta' });
    await untilTurnEnded(client, [a.id, b.id]);

    const eventsA = client.eventsOf(a.id);
    const eventsB = client.eventsOf(b.id);
    expect(eventsA.filter((event) => event.kind === 'user_message')).toMatchObject([{ text: 'alpha' }]);
    expect(eventsB.filter((event) => event.kind === 'user_message')).toMatchObject([{ text: 'beta' }]);
    expect(chunksOf(eventsA)).toEqual(['Eco: ', 'alpha']);
    expect(chunksOf(eventsB)).toEqual(['Eco: ', 'beta']);
    expect(eventsA.every((event) => event.sessionId === a.id)).toBe(true);
    expect(eventsB.every((event) => event.sessionId === b.id)).toBe(true);
    expect(eventsA.map((event) => event.seq)).toEqual(
      daemon.db
        .prepare<[string], { seq: number }>('SELECT seq FROM events WHERE session_id = ? ORDER BY seq')
        .all(a.id)
        .map((row) => row.seq),
    );
    await client.close();
  });

  it('permissão pendente numa sessão não aparece na outra, que segue o turno normalmente', async () => {
    const { a, b, client } = await twoSessions();

    client.send({ type: 'prompt', sessionId: a.id, text: 'permission' });
    const request = await client.waitFor((message) => message.type === 'event' && message.event.sessionId === a.id && message.event.kind === 'permission_request');
    if (request.type !== 'event' || request.event.kind !== 'permission_request') throw new Error('sem permissão');

    client.send({ type: 'prompt', sessionId: b.id, text: 'beta' });
    await client.waitFor((message) => message.type === 'event' && message.event.sessionId === b.id && message.event.kind === 'turn_end');

    expect(client.eventsOf(b.id).some((event) => event.kind === 'permission_request')).toBe(false);
    expect(chunksOf(client.eventsOf(b.id))).toEqual(['Eco: ', 'beta']);

    client.send({ type: 'permission_response', sessionId: a.id, requestId: request.event.requestId, optionId: 'allow' });
    await client.waitFor(isEvent('turn_end'));
    expect(client.eventsOf(a.id).filter((event) => event.kind === 'turn_end')).toHaveLength(1);
    expect(chunksOf(client.eventsOf(a.id)).at(-1)).toBe('Escolhida: allow');
    await client.close();
  });
});
