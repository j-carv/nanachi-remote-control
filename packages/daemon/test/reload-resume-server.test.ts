import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveIdleSessionsForReload, takeResumeAfterReload } from '../src/reload-resume.js';
import { insertSession, stopInterruptedSessions, updateSession } from '../src/repository.js';
import { createSession, createWorkspace, fakeAgent, isEvent, listen, pairToken, WsTestClient } from './agent-support.js';
import { startDaemon, stopDaemon, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Simula o que o main faz num reload: o daemon A salva as sessões idle e sai (o agente morre, o banco não muda);
 * o daemon B sobe com a lista lida do arquivo, marca tudo como stopped (como a subida faz) e retoma sozinho.
 */
let home: string;
let pidDir: string;
let open: TestDaemon[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nanachi-reload-'));
  pidDir = join(home, 'pids');
  await mkdir(pidDir);
  open = [];
});

afterEach(async () => {
  for (const daemon of open.splice(0)) await stopDaemon(daemon).catch(() => undefined);
  await removeTempDir(home);
});

function fakeConfig(): Record<string, unknown> {
  return {
    allowedRoots: [home],
    agents: {
      fake: fakeAgent({
        FAKE_AGENT_PID_DIR: pidDir,
        FAKE_AGENT_STORE: join(home, 'store.json'),
      }),
    },
  };
}

async function waitForStatus(daemon: TestDaemon, sessionId: string, status: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = daemon.db
      .prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?')
      .get(sessionId);
    if (row?.status === status) return;
    if (Date.now() > deadline) throw new Error(`sessão ${sessionId} não chegou a ${status} (está ${row?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function statusOf(daemon: TestDaemon, sessionId: string): string | undefined {
  return daemon.db.prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?').get(sessionId)?.status;
}

describe('retomada depois de reload', () => {
  it('sessão idle volta a idle sozinha no startup, aceita prompt e o agente novo recebe session/load; agente desconhecido fica stopped', async () => {
    const a = await startDaemon(home, { config: fakeConfig() });
    open.push(a);
    await mkdir(join(home, 'ws'));
    const workspaceId = await createWorkspace(a, join(home, 'ws'));
    const session = await createSession(a, { workspaceId, agent: 'fake' });
    insertSession(a.db, { id: 'sumiu', workspaceId, agent: 'agente-que-nao-existe', title: 'x', status: 'idle', createdAt: 1 });
    updateSession(a.db, 'sumiu', { acpSessionId: 'acp-sumiu' }, 1);

    const saved = saveIdleSessionsForReload(a.db, home, Date.now());
    expect([...saved].sort()).toEqual([session.id, 'sumiu'].sort());
    await stopDaemon(a);
    open.splice(open.indexOf(a), 1);

    const ids = takeResumeAfterReload(home, Date.now());
    const b = await startDaemon(home, { resumeAfterReload: ids });
    open.push(b);
    stopInterruptedSessions(b.db, Date.now());
    const url = await listen(b);

    await waitForStatus(b, session.id, 'idle');
    expect(statusOf(b, 'sumiu')).toBe('stopped');

    const statuses = b.db
      .prepare<[string], { payload: string }>("SELECT payload FROM events WHERE session_id = ? AND kind = 'status' ORDER BY seq")
      .all(session.id)
      .map((row) => (JSON.parse(row.payload) as { status: string }).status);
    expect(statuses.slice(-2)).toEqual(['starting', 'idle']);

    const methods = await readFile(join(pidDir, `${session.id}.methods.jsonl`), 'utf8');
    expect(methods).toContain('"session/load"');

    const client = await WsTestClient.connect(url, await pairToken(b));
    client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
    client.send({ type: 'prompt', sessionId: session.id, text: 'depois do reload' });
    await client.waitFor(isEvent('turn_end'));
    await client.waitFor((message) => message.type === 'event' && message.event.kind === 'status' && message.event.status === 'idle');
    expect(client.eventsOf(session.id).some((event) => event.kind === 'error')).toBe(false);
    await client.close();
  });
});
