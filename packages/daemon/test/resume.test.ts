import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSchema, WorkspaceSchema, type AgentConfig, type Session, type SessionEvent } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  crashingAgent,
  fakeAgent,
  isAlive,
  isEvent,
  listen,
  pairToken,
  waitUntilDead,
  WsTestClient,
} from './agent-support.js';
import { insertSession, listEvents, updateSession } from '../src/repository.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-resume-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach do vitest roda em pilha, então este roda por último
// (depois que os daemons já mataram os agentes, que mantêm o cwd dentro do workspace).
const env = setupDaemonTests();

function agents(): Record<string, AgentConfig> {
  const pid = { FAKE_AGENT_PID_DIR: pidDir };
  return {
    fake: fakeAgent(pid),
    retoma: fakeAgent({ ...pid, FAKE_AGENT_RESUME: 'resume' }),
    semretomar: fakeAgent({ ...pid, FAKE_AGENT_RESUME: 'none' }),
    modos: fakeAgent({ ...pid, FAKE_AGENT_STYLE: 'modes' }),
    morre: crashingAgent(),
  };
}

async function start(): Promise<TestDaemon> {
  return env.start({ config: { allowedRoots: [base], agents: agents() } });
}

async function createWorkspaceId(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

/** Pid do processo do agente mais recente da sessão (o fake regrava o arquivo a cada spawn). */
async function agentPid(sessionId: string): Promise<number> {
  return Number((await readFile(join(pidDir, `${sessionId}.pid`), 'utf8')).trim());
}

async function stop(daemon: TestDaemon, sessionId: string): Promise<void> {
  const res = await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}`, headers: await authHeader(daemon) });
  expect(res.statusCode).toBe(204);
}

async function resume(daemon: TestDaemon, sessionId: string): Promise<{ status: number; body: unknown }> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/resume`,
    headers: await authHeader(daemon),
  });
  return { status: res.statusCode, body: res.json<unknown>() };
}

/** Sessão criada e parada: já tem acp_session_id no banco, como depois de um daemon reiniciado. */
async function stoppedSession(daemon: TestDaemon, agent: string, config?: Record<string, string | boolean>): Promise<Session> {
  const workspaceId = await createWorkspaceId(daemon);
  const session = await createSession(daemon, { workspaceId, agent, ...(config ? { config } : {}) });
  await stop(daemon, session.id);
  return session;
}

function eventsOf(daemon: TestDaemon, sessionId: string): SessionEvent[] {
  return listEvents(daemon.db, sessionId, 0, 10_000);
}

describe('POST /api/sessions/:id/resume com session/load', () => {
  it('sobe um processo novo, volta a idle e o histórico reenviado pelo agente não vira evento', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'fake', { model: 'slow-model' });
    const oldPid = await agentPid(stopped.id);
    const before = eventsOf(daemon, stopped.id).map((event) => event.seq);

    const { status, body } = await resume(daemon, stopped.id);

    expect(status).toBe(200);
    const session = SessionSchema.parse(body);
    expect(session.status).toBe('idle');
    const newPid = await agentPid(stopped.id);
    expect(newPid).not.toBe(oldPid);
    expect(isAlive(newPid)).toBe(true);

    const added = eventsOf(daemon, stopped.id).filter((event) => !before.includes(event.seq));
    expect(added.map((event) => event.kind)).toEqual(['status']);
    expect(added[0]).toMatchObject({ kind: 'status', status: 'idle' });
    expect(eventsOf(daemon, stopped.id).some((event) => event.kind === 'agent_message_chunk')).toBe(false);
  });

  it('configOptions da resposta do load substituem as salvas (o agente novo abre com o modelo padrão)', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'fake', { model: 'slow-model' });
    expect(stopped.configOptions.find((option) => option.id === 'model')).toMatchObject({ currentValue: 'slow-model' });

    const { body } = await resume(daemon, stopped.id);

    expect(SessionSchema.parse(body).configOptions.find((option) => option.id === 'model')).toMatchObject({
      currentValue: 'fast',
    });
  });

  it('o broadcast de session chega aos WS abertos com status idle', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'fake');
    const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));

    await resume(daemon, stopped.id);

    await client.waitFor((message) => message.type === 'session' && message.session.id === stopped.id && message.session.status === 'idle');
    await client.close();
  });

  it('depois de retomar, a sessão aceita prompt e o turno termina', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'fake');
    await resume(daemon, stopped.id);
    const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
    client.send({ type: 'subscribe', sessionId: stopped.id, afterSeq: 0 });
    await client.sync();

    client.send({ type: 'prompt', sessionId: stopped.id, text: 'de novo' });
    const turnEnd = await client.waitFor(isEvent('turn_end'));

    expect(turnEnd).toMatchObject({ event: { stopReason: 'end_turn' } });
    await client.close();
  });
});

describe('POST /api/sessions/:id/resume com session/resume', () => {
  it('agente que anuncia sessionCapabilities.resume volta a idle pelo session/resume', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'retoma');

    const { status, body } = await resume(daemon, stopped.id);

    expect(status).toBe(200);
    expect(SessionSchema.parse(body).status).toBe('idle');
  });

  it('agente que só anuncia modes: a opção mode sintetizada vem da resposta', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'modos');

    const { body } = await resume(daemon, stopped.id);

    expect(SessionSchema.parse(body).configOptions).toEqual([
      expect.objectContaining({ id: 'mode', category: 'mode', type: 'select', currentValue: 'default' }),
    ]);
  });
});

describe('recusas', () => {
  it('agente sem loadSession nem resume → 409 not_resumable; sessão fica stopped e o processo morre', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'semretomar');

    const { status, body } = await resume(daemon, stopped.id);

    expect(status).toBe(409);
    expect(body).toEqual({ error: 'not_resumable' });
    expect(await waitUntilDead(await agentPid(stopped.id))).toBe(true);
    const row = daemon.db
      .prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?')
      .get(stopped.id);
    expect(row?.status).toBe('stopped');
    expect(eventsOf(daemon, stopped.id).map((event) => event.kind)).not.toContain('error');
  });

  it('sessão sem acp_session_id → 409 not_resumable, sem subir processo', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspaceId(daemon);
    insertSession(daemon.db, { id: 'sem-acp', workspaceId, agent: 'fake', title: 'x', status: 'error', createdAt: 1 });

    const { status, body } = await resume(daemon, 'sem-acp');

    expect(status).toBe(409);
    expect(body).toEqual({ error: 'not_resumable' });
    expect(await readFile(join(pidDir, 'sem-acp.pid'), 'utf8').catch(() => 'sem processo')).toBe('sem processo');
  });

  it('sessão já viva → 409 already_running, sem mudar o status', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspaceId(daemon);
    const live = await createSession(daemon, { workspaceId, agent: 'fake' });

    const { status, body } = await resume(daemon, live.id);

    expect(status).toBe(409);
    expect(body).toEqual({ error: 'already_running' });
    const row = daemon.db.prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?').get(live.id);
    expect(row?.status).toBe('idle');
  });

  it('teto de 8 sessões vivas → 429 too_many_sessions e a sessão continua stopped', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'fake');
    const workspaceId = await createWorkspaceId(daemon);
    for (let i = 0; i < 8; i++) {
      insertSession(daemon.db, { id: `viva-${i}`, workspaceId, agent: 'fake', title: 'x', status: 'idle', createdAt: 0 });
    }

    const { status, body } = await resume(daemon, stopped.id);

    expect(status).toBe(429);
    expect(body).toEqual({ error: 'too_many_sessions' });
    const row = daemon.db.prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?').get(stopped.id);
    expect(row?.status).toBe('stopped');
  });

  it('sessão desconhecida → 404 not_found; sem token → 401', async () => {
    const daemon = await start();
    expect((await resume(daemon, 'nao-existe')).status).toBe(404);
    const noToken = await daemon.app.inject({ method: 'POST', url: '/api/sessions/nao-existe/resume' });
    expect(noToken.statusCode).toBe(401);
  });
});

describe('falha na retomada', () => {
  it('agente que morre ao retomar → 200 com status error e evento error', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspaceId(daemon);
    insertSession(daemon.db, { id: 'morta', workspaceId, agent: 'morre', title: 'x', status: 'stopped', createdAt: 1 });
    updateSession(daemon.db, 'morta', { acpSessionId: 'acp-1' }, 2);

    const { status, body } = await resume(daemon, 'morta');

    expect(status).toBe(200);
    expect(SessionSchema.parse(body).status).toBe('error');
    expect(eventsOf(daemon, 'morta').map((event) => event.kind)).toContain('error');
  });
});
