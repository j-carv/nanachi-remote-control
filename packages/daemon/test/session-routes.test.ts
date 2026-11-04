import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventsResponseSchema,
  SessionsResponseSchema,
  WorkspaceSchema,
  type AgentConfig,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  crashingAgent,
  createSession,
  fakeAgent,
  fetchConfigOptions,
  isAlive,
  waitUntilDead,
} from './agent-support.js';
import { insertSession } from '../src/repository.js';
import { setupDaemonTests, startDaemon, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-sess-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o vitest roda afterEach em pilha, então este roda por último
// (depois que os daemons já mataram os agentes, que mantêm o cwd dentro do workspace).
const env = setupDaemonTests();

function agents(): Record<string, AgentConfig> {
  return {
    fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }),
    modos: fakeAgent({ FAKE_AGENT_STYLE: 'modes', FAKE_AGENT_PID_DIR: pidDir }),
    morre: crashingAgent(),
  };
}

async function start(): Promise<TestDaemon> {
  return env.start({ config: { allowedRoots: [base], agents: agents() } });
}

async function createWorkspace(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

/** Pid do agente, escrito pelo fake quando sobe (nome = id da sessão, vindo de AGENT_SESSION_ID). */
async function agentPid(sessionId: string): Promise<number> {
  return Number((await readFile(join(pidDir, `${sessionId}.pid`), 'utf8')).trim());
}

describe('POST /api/sessions', () => {
  it('sobe o agente, aplica config (ids desconhecidos ignorados) e termina idle com configOptions achatadas', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);

    const session = await createSession(daemon, {
      workspaceId,
      agent: 'fake',
      config: { thought: 'high', model: 'slow-model', naoExiste: 'x' },
    });

    expect(session).toMatchObject({ workspaceId, agent: 'fake', title: 'Nova sessão', status: 'idle' });
    const configOptions = await fetchConfigOptions(daemon, session.id);
    expect(configOptions.map((option) => option.id)).toEqual(['mode', 'model', 'thought', 'ultra']);
    const model = configOptions.find((option) => option.id === 'model');
    expect(model).toMatchObject({ type: 'select', currentValue: 'slow-model' });
    expect(model?.type === 'select' ? model.options.map((option) => option.value) : []).toEqual(['fast', 'slow-model']);
    expect(configOptions.find((option) => option.id === 'thought')).toMatchObject({ currentValue: 'high' });
    expect(session).not.toHaveProperty('configOptions');

    const events = await daemon.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/events`,
      headers: await authHeader(daemon),
    });
    const kinds = EventsResponseSchema.parse(events.json<unknown>()).events.map((event) =>
      event.kind === 'status' ? `status:${event.status}` : event.kind,
    );
    expect(kinds).toEqual(['status:starting', 'status:idle']);
  });

  it('workspace inexistente → 404 not_found; agente desconhecido → 400 unknown_agent', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);

    const noWorkspace = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId: 'nao-existe', agent: 'fake' },
    });
    expect(noWorkspace.statusCode).toBe(404);
    expect(noWorkspace.json<unknown>()).toEqual({ error: 'not_found' });

    const noAgent = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId, agent: 'nao-existe' },
    });
    expect(noAgent.statusCode).toBe(400);
    expect(noAgent.json<unknown>()).toEqual({ error: 'unknown_agent' });
  });

  it('agente que encerra ao iniciar → 201 com status error e evento error', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);

    const session = await createSession(daemon, { workspaceId, agent: 'morre' });

    expect(session.status).toBe('error');
    const events = await daemon.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/events`,
      headers: await authHeader(daemon),
    });
    expect(EventsResponseSchema.parse(events.json<unknown>()).events.map((event) => event.kind)).toContain('error');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'nome herdado do Object (%s) não é agente: 400 unknown_agent e nenhuma sessão gravada',
    async (agent) => {
      const daemon = await start();
      const workspaceId = await createWorkspace(daemon);

      const res = await daemon.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: await authHeader(daemon),
        payload: { workspaceId, agent },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json<unknown>()).toEqual({ error: 'unknown_agent' });
      expect(daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    },
  );

  it('a 9ª sessão viva do daemon → 429 too_many_sessions, sem gravar nada', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    for (let i = 0; i < 8; i++) {
      insertSession(daemon.db, { id: `viva-${i}`, workspaceId, agent: 'fake', title: 'x', status: 'idle', createdAt: 0 });
    }

    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId, agent: 'fake' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json<unknown>()).toEqual({ error: 'too_many_sessions' });
    expect(daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 8 });
  });

  it('sessões stopped ou error não contam para o limite de vivas', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    for (let i = 0; i < 8; i++) {
      const status = i % 2 === 0 ? 'stopped' : 'error';
      insertSession(daemon.db, { id: `morta-${i}`, workspaceId, agent: 'fake', title: 'x', status, createdAt: 0 });
    }

    const session = await createSession(daemon, { workspaceId, agent: 'fake' });
    expect(session.status).toBe('idle');
  });

  it('corpo fora do schema → 400 invalid_request', async () => {
    const daemon = await start();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<unknown>()).toEqual({ error: 'invalid_request' });
  });

  it('sem token → 401', async () => {
    const daemon = await start();
    const res = await daemon.app.inject({ method: 'POST', url: '/api/sessions', payload: { workspaceId: 'x', agent: 'fake' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /api/sessions/:id', () => {
  it('encerra o processo do agente e deixa a sessão stopped', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspace(daemon), agent: 'fake' });
    const pid = await agentPid(session.id);
    expect(isAlive(pid)).toBe(true);

    const res = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}`,
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(204);
    expect(await waitUntilDead(pid)).toBe(true);
    const list = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${session.workspaceId}/sessions`,
      headers: await authHeader(daemon),
    });
    expect(SessionsResponseSchema.parse(list.json<unknown>()).sessions[0]?.status).toBe('stopped');
  });

  it('sessão desconhecida → 404; sem token → 401', async () => {
    const daemon = await start();
    const headers = await authHeader(daemon);
    expect((await daemon.app.inject({ method: 'DELETE', url: '/api/sessions/nao-existe', headers })).statusCode).toBe(404);
    expect((await daemon.app.inject({ method: 'DELETE', url: '/api/sessions/nao-existe' })).statusCode).toBe(401);
  });
});

describe('GET /api/sessions/:id/events', () => {
  it('after e limit paginam em ordem de seq; limit default 200', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspace(daemon), agent: 'fake' });
    const headers = await authHeader(daemon);
    const get = (query: string) =>
      daemon.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/events${query}`, headers });

    const all = EventsResponseSchema.parse((await get('')).json<unknown>()).events;
    expect(all.map((event) => event.seq)).toEqual([1, 2]);

    const afterFirst = EventsResponseSchema.parse((await get('?after=1')).json<unknown>()).events;
    expect(afterFirst.map((event) => event.seq)).toEqual([2]);

    const one = EventsResponseSchema.parse((await get('?limit=1')).json<unknown>()).events;
    expect(one.map((event) => event.seq)).toEqual([1]);
  });

  it('parâmetros inválidos → 400; sessão desconhecida → 404', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspace(daemon), agent: 'fake' });
    const headers = await authHeader(daemon);
    const get = (query: string) =>
      daemon.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/events${query}`, headers });

    expect((await get('?limit=501')).statusCode).toBe(400);
    expect((await get('?limit=0')).statusCode).toBe(400);
    expect((await get('?after=-1')).statusCode).toBe(400);
    expect((await get('?after=abc')).statusCode).toBe(400);
    expect(
      (await daemon.app.inject({ method: 'GET', url: '/api/sessions/nao-existe/events', headers })).statusCode,
    ).toBe(404);
    expect((await daemon.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/events` })).statusCode).toBe(401);
  });
});

describe('ciclo de vida dos processos', () => {
  it('apagar o workspace encerra as sessões dele', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake' });
    const pid = await agentPid(session.id);

    const res = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}`,
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(204);
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('fechar o daemon mata os agentes', async () => {
    const daemon = await startDaemon(env.home, { config: { allowedRoots: [base], agents: agents() } });
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake' });
    const pid = await agentPid(session.id);

    await daemon.app.close();
    daemon.db.close();

    expect(await waitUntilDead(pid)).toBe(true);
  });
});
