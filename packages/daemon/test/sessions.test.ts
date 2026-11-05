import { ConfigOptionsResponseSchema, SessionsResponseSchema, type PairResponse, type SessionStatus } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { stopInterruptedSessions } from '../src/repository.js';
import { issueCode, setupDaemonTests, type TestDaemon } from './support.js';

const env = setupDaemonTests();

const SELECT_OPTION = {
  id: 'mode',
  name: 'Acesso',
  category: 'mode',
  type: 'select',
  currentValue: 'default',
  options: [{ value: 'default', name: 'Padrão' }],
};

async function auth(daemon: TestDaemon): Promise<{ authorization: string }> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: issueCode(daemon), deviceName: 'iPhone' },
  });
  return { authorization: `Bearer ${res.json<PairResponse>().token}` };
}

/** Insere workspace direto no banco: a criação de sessão ainda não existe nesta fase. */
function insertWorkspace(daemon: TestDaemon, id: string): void {
  daemon.db
    .prepare<[string, string, string, number]>('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)')
    .run(id, id, `C:\\projetos\\${id}`, 1);
}

function insertSession(
  daemon: TestDaemon,
  row: {
    id: string;
    workspaceId: string;
    agent?: string;
    status: SessionStatus;
    createdAt: number;
    updatedAt: number;
    configOptions?: string;
    kind?: 'acp' | 'pty';
  },
): void {
  daemon.db
    .prepare<[string, string, string, string, string, string, number, number]>(
      `INSERT INTO sessions (id, workspace_id, agent, kind, title, status, config_options, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Título', ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.workspaceId,
      row.agent ?? 'omp',
      row.kind ?? 'acp',
      row.status,
      row.configOptions ?? '[]',
      row.createdAt,
      row.updatedAt,
    );
}

describe('GET /api/workspaces/:id/sessions', () => {
  it('workspace sem sessões → lista vazia', async () => {
    const daemon = await env.start();
    insertWorkspace(daemon, 'ws-1');
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/sessions',
      headers: await auth(daemon),
    });

    expect(res.statusCode).toBe(200);
    expect(SessionsResponseSchema.parse(res.json<unknown>())).toEqual({ sessions: [] });
  });

  it('lista do banco, mais recente primeiro, sem configOptions (elas ficam em GET /config)', async () => {
    const daemon = await env.start();
    insertWorkspace(daemon, 'ws-1');
    insertWorkspace(daemon, 'ws-2');
    insertSession(daemon, { id: 'antiga', workspaceId: 'ws-1', status: 'idle', createdAt: 10, updatedAt: 20 });
    insertSession(daemon, {
      id: 'nova',
      workspaceId: 'ws-1',
      status: 'running',
      createdAt: 30,
      updatedAt: 31,
      configOptions: JSON.stringify([SELECT_OPTION]),
    });
    insertSession(daemon, { id: 'de-outro', workspaceId: 'ws-2', status: 'idle', createdAt: 40, updatedAt: 40 });

    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/sessions',
      headers: await auth(daemon),
    });

    const body = SessionsResponseSchema.parse(res.json<unknown>());
    expect(body.sessions.map((session) => session.id)).toEqual(['nova', 'antiga']);
    expect(body.sessions[0]).toEqual({
      id: 'nova',
      workspaceId: 'ws-1',
      agent: 'omp',
      kind: 'acp',
      title: 'Título',
      status: 'running',
      accountId: null,
      worktree: null,
      createdAt: 30,
      updatedAt: 31,
    });
    expect(body.sessions[0]).not.toHaveProperty('configOptions');
  });

  it('GET /api/sessions/:id/config devolve as opções gravadas; sessão inexistente dá 404', async () => {
    const daemon = await env.start();
    insertWorkspace(daemon, 'ws-1');
    insertSession(daemon, {
      id: 'com-opcoes',
      workspaceId: 'ws-1',
      status: 'idle',
      createdAt: 10,
      updatedAt: 10,
      configOptions: JSON.stringify([SELECT_OPTION]),
    });

    const found = await daemon.app.inject({ method: 'GET', url: '/api/sessions/com-opcoes/config', headers: await auth(daemon) });
    expect(found.statusCode).toBe(200);
    expect(ConfigOptionsResponseSchema.parse(found.json<unknown>())).toEqual({ configOptions: [SELECT_OPTION] });

    const missing = await daemon.app.inject({ method: 'GET', url: '/api/sessions/nao-existe/config', headers: await auth(daemon) });
    expect(missing.statusCode).toBe(404);
  });

  it('kind vem gravado na sessão: não muda se o agente sumir ou mudar de tipo no config', async () => {
    const daemon = await env.start();
    insertWorkspace(daemon, 'ws-1');
    insertSession(daemon, { id: 'do-agy', workspaceId: 'ws-1', agent: 'agy', kind: 'pty', status: 'stopped', createdAt: 10, updatedAt: 10 });
    insertSession(daemon, { id: 'sumiu', workspaceId: 'ws-1', agent: 'sumiu', status: 'stopped', createdAt: 20, updatedAt: 20 });
    insertSession(daemon, { id: 'omp-virou-pty', workspaceId: 'ws-1', agent: 'omp', kind: 'pty', status: 'stopped', createdAt: 30, updatedAt: 30 });

    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/workspaces/ws-1/sessions',
      headers: await auth(daemon),
    });

    const body = SessionsResponseSchema.parse(res.json<unknown>());
    expect(body.sessions.map((session) => [session.id, session.kind])).toEqual([
      ['omp-virou-pty', 'pty'],
      ['sumiu', 'acp'],
      ['do-agy', 'pty'],
    ]);
  });

  it('workspace inexistente → 404 not_found', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/workspaces/nao-existe/sessions',
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<unknown>()).toEqual({ error: 'not_found' });
  });

  it('sem token → 401', async () => {
    const daemon = await env.start();
    insertWorkspace(daemon, 'ws-1');
    expect((await daemon.app.inject({ method: 'GET', url: '/api/workspaces/ws-1/sessions' })).statusCode).toBe(401);
  });
});

describe('stopInterruptedSessions (startup)', () => {
  it('starting, idle, running e awaiting_permission viram stopped; stopped e error ficam como estão', async () => {
    const daemon = await env.start();
    insertWorkspace(daemon, 'ws-1');
    const statuses: SessionStatus[] = ['starting', 'idle', 'running', 'awaiting_permission', 'stopped', 'error'];
    statuses.forEach((status, index) => {
      insertSession(daemon, { id: `s-${index}`, workspaceId: 'ws-1', status, createdAt: index, updatedAt: index });
    });

    const changed = stopInterruptedSessions(daemon.db, 999);

    expect(changed).toBe(4);
    const rows = daemon.db
      .prepare<[], { id: string; status: string; updated_at: number }>('SELECT id, status, updated_at FROM sessions ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 's-0', status: 'stopped', updated_at: 999 },
      { id: 's-1', status: 'stopped', updated_at: 999 },
      { id: 's-2', status: 'stopped', updated_at: 999 },
      { id: 's-3', status: 'stopped', updated_at: 999 },
      { id: 's-4', status: 'stopped', updated_at: 4 },
      { id: 's-5', status: 'error', updated_at: 5 },
    ]);
  });

  it('é idempotente: segunda chamada não altera nada', async () => {
    const daemon = await env.start();
    insertWorkspace(daemon, 'ws-1');
    insertSession(daemon, { id: 's-1', workspaceId: 'ws-1', status: 'running', createdAt: 1, updatedAt: 1 });

    stopInterruptedSessions(daemon.db, 2);
    expect(stopInterruptedSessions(daemon.db, 3)).toBe(0);
  });
});
