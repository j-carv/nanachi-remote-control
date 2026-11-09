import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentsResponseSchema,
  FsListResponseSchema,
  RootsResponseSchema,
  WorkspaceSchema,
  WorkspacesResponseSchema,
  type PairResponse,
  type Workspace,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceDeletedHandler } from '../src/server.js';
import { issueCode, setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

const env = setupDaemonTests();

let base: string;
/** Raiz permitida usada pelo config dos testes. */
let roots: string;
/** Pasta fora das raízes. */
let outside: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-allowed-')));
  roots = join(base, 'projetos');
  outside = join(base, 'fora');
  await mkdir(join(roots, 'app', 'src'), { recursive: true });
  await mkdir(join(roots, 'outro'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(roots, 'notas.txt'), 'x');
});

afterEach(async () => {
  await removeTempDir(base);
});

async function startWith(allowedRoots: string[] = [roots], onWorkspaceDeleted?: WorkspaceDeletedHandler): Promise<TestDaemon> {
  return env.start({ config: { allowedRoots }, onWorkspaceDeleted });
}

/** Pareia um dispositivo e devolve o header Authorization pronto para `inject`. */
async function auth(daemon: TestDaemon): Promise<{ authorization: string }> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: issueCode(daemon), deviceName: 'iPhone' },
  });
  return { authorization: `Bearer ${res.json<PairResponse>().token}` };
}

async function createWorkspace(daemon: TestDaemon, path: string): Promise<Workspace> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await auth(daemon),
    payload: { path },
  });
  return WorkspaceSchema.parse(res.json<unknown>());
}

describe('GET /api/roots', () => {
  it('lista as raízes permitidas com o nome = última pasta', async () => {
    const daemon = await startWith([roots, outside]);
    const res = await daemon.app.inject({ method: 'GET', url: '/api/roots', headers: await auth(daemon) });

    expect(res.statusCode).toBe(200);
    expect(RootsResponseSchema.parse(res.json<unknown>()).roots).toEqual([
      { path: roots, name: 'projetos' },
      { path: outside, name: 'fora' },
    ]);
  });

  it('allowedRoots vazio → lista vazia', async () => {
    const daemon = await startWith([]);
    const res = await daemon.app.inject({ method: 'GET', url: '/api/roots', headers: await auth(daemon) });

    expect(RootsResponseSchema.parse(res.json<unknown>())).toEqual({ roots: [] });
  });

  it('sem token → 401', async () => {
    const daemon = await startWith();
    expect((await daemon.app.inject({ method: 'GET', url: '/api/roots' })).statusCode).toBe(401);
  });
});

describe('GET /api/fs', () => {
  it('lista subpastas da raiz com parent null', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/fs?path=${encodeURIComponent(roots)}`,
      headers: await auth(daemon),
    });

    expect(res.statusCode).toBe(200);
    expect(FsListResponseSchema.parse(res.json<unknown>())).toEqual({
      path: roots,
      parent: null,
      dirs: [
        { name: 'app', path: join(roots, 'app') },
        { name: 'outro', path: join(roots, 'outro') },
      ],
    });
  });

  it('subpasta traz parent apontando para a pasta de cima', async () => {
    const daemon = await startWith();
    const target = join(roots, 'app');
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/fs?path=${encodeURIComponent(target)}`,
      headers: await auth(daemon),
    });

    const body = FsListResponseSchema.parse(res.json<unknown>());
    expect(body.parent).toBe(roots);
    expect(body.dirs).toEqual([{ name: 'src', path: join(target, 'src') }]);
  });

  it('path fora das raízes → 403 outside_roots', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/fs?path=${encodeURIComponent(outside)}`,
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<unknown>()).toEqual({ error: 'outside_roots' });
  });

  it('.. que sai da raiz → 403', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/fs?path=${encodeURIComponent(join(roots, '..', 'fora'))}`,
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(403);
  });

  it('pasta inexistente dentro da raiz → 404 not_found', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/fs?path=${encodeURIComponent(join(roots, 'nao-existe'))}`,
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<unknown>()).toEqual({ error: 'not_found' });
  });

  it('arquivo no lugar de pasta → 400 not_a_directory', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/fs?path=${encodeURIComponent(join(roots, 'notas.txt'))}`,
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<unknown>()).toEqual({ error: 'not_a_directory' });
  });

  it('sem o parâmetro path → 400', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({ method: 'GET', url: '/api/fs', headers: await auth(daemon) });
    expect(res.statusCode).toBe(400);
    expect(res.json<unknown>()).toEqual({ error: 'invalid_request' });
  });

  it('allowedRoots vazio → qualquer path é 403', async () => {
    const daemon = await startWith([]);
    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/fs?path=${encodeURIComponent(roots)}`,
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(403);
  });

  it('sem token → 401', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({ method: 'GET', url: `/api/fs?path=${encodeURIComponent(roots)}` });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/agents', () => {
  it('lista os agentes default com kind quando o config não define agents', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({ method: 'GET', url: '/api/agents', headers: await auth(daemon) });

    expect(res.statusCode).toBe(200);
    expect(AgentsResponseSchema.parse(res.json<unknown>())).toEqual({
      agents: [
        { id: 'omp', label: 'Oh My Pi', kind: 'acp' },
        { id: 'claude', label: 'Claude Code', kind: 'acp' },
        { id: 'codex', label: 'Codex', kind: 'acp' },
        { id: 'agy', label: 'Antigravity', kind: 'acp' },
      ],
    });
  });

  it('soma os agentes do config aos defaults que ele não define', async () => {
    const daemon = await env.start({
      config: { agents: { x: { label: 'Outro', command: 'outro', args: [] } } },
    });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/agents', headers: await auth(daemon) });
    expect(AgentsResponseSchema.parse(res.json<unknown>())).toEqual({
      agents: [
        { id: 'omp', label: 'Oh My Pi', kind: 'acp' },
        { id: 'claude', label: 'Claude Code', kind: 'acp' },
        { id: 'codex', label: 'Codex', kind: 'acp' },
        { id: 'agy', label: 'Antigravity', kind: 'acp' },
        { id: 'x', label: 'Outro', kind: 'acp' },
      ],
    });
  });

  it('sem token → 401', async () => {
    const daemon = await env.start();
    expect((await daemon.app.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(401);
  });
});

describe('workspaces', () => {
  it('lista começa vazia e valida contra WorkspacesResponseSchema', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({ method: 'GET', url: '/api/workspaces', headers: await auth(daemon) });

    expect(res.statusCode).toBe(200);
    expect(WorkspacesResponseSchema.parse(res.json<unknown>())).toEqual({ workspaces: [] });
  });

  it('POST cria com nome = basename, path canônico e 201', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: await auth(daemon),
      payload: { path: join(roots, 'app') },
    });

    expect(res.statusCode).toBe(201);
    expect(WorkspaceSchema.parse(res.json<unknown>())).toEqual({
      id: expect.any(String),
      name: 'app',
      path: join(roots, 'app'),
      createdAt: expect.any(Number),
      muted: false,
    });
  });

  it('POST aceita name explícito', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: await auth(daemon),
      payload: { path: join(roots, 'app'), name: 'Meu app' },
    });
    expect(WorkspaceSchema.parse(res.json<unknown>()).name).toBe('Meu app');
  });

  it('POST da raiz em si é aceito', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: await auth(daemon),
      payload: { path: roots },
    });
    expect(res.statusCode).toBe(201);
  });

  it('POST de caminho já cadastrado devolve o existente (200, mesmo id)', async () => {
    const daemon = await startWith();
    const headers = await auth(daemon);
    const first = await createWorkspace(daemon, join(roots, 'app'));

    const again = await daemon.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers,
      payload: { path: join(roots, 'app'), name: 'outro nome' },
    });
    expect(again.statusCode).toBe(200);
    expect(WorkspaceSchema.parse(again.json<unknown>())).toEqual(first);

    const list = await daemon.app.inject({ method: 'GET', url: '/api/workspaces', headers });
    expect(WorkspacesResponseSchema.parse(list.json<unknown>()).workspaces).toHaveLength(1);
  });

  it('POST fora das raízes → 403 outside_roots, nada gravado', async () => {
    const daemon = await startWith();
    const headers = await auth(daemon);
    const res = await daemon.app.inject({ method: 'POST', url: '/api/workspaces', headers, payload: { path: outside } });

    expect(res.statusCode).toBe(403);
    expect(res.json<unknown>()).toEqual({ error: 'outside_roots' });
    const list = await daemon.app.inject({ method: 'GET', url: '/api/workspaces', headers });
    expect(WorkspacesResponseSchema.parse(list.json<unknown>()).workspaces).toEqual([]);
  });

  it('POST de pasta inexistente → 404', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: await auth(daemon),
      payload: { path: join(roots, 'nao-existe') },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<unknown>()).toEqual({ error: 'not_found' });
  });

  it('POST com body fora do schema → 400 invalid_request', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: await auth(daemon),
      payload: { name: 'sem path' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<unknown>()).toEqual({ error: 'invalid_request' });
  });

  it('POST com JSON malformado → 400 invalid_request (erro JSON, não HTML)', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: { ...(await auth(daemon)), 'content-type': 'application/json' },
      payload: '{ nope',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<unknown>()).toEqual({ error: 'invalid_request' });
  });

  it('DELETE remove da lista e responde 204', async () => {
    const daemon = await startWith();
    const headers = await auth(daemon);
    const created = await createWorkspace(daemon, join(roots, 'app'));

    const res = await daemon.app.inject({ method: 'DELETE', url: `/api/workspaces/${created.id}`, headers });
    expect(res.statusCode).toBe(204);

    const list = await daemon.app.inject({ method: 'GET', url: '/api/workspaces', headers });
    expect(WorkspacesResponseSchema.parse(list.json<unknown>()).workspaces).toEqual([]);
  });

  it('DELETE de id desconhecido → 404', async () => {
    const daemon = await startWith();
    const res = await daemon.app.inject({
      method: 'DELETE',
      url: '/api/workspaces/nao-existe',
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<unknown>()).toEqual({ error: 'not_found' });
  });

  it('DELETE marca as sessões não paradas como stopped e chama onWorkspaceDeleted com os ids', async () => {
    const calls: Array<{ workspaceId: string; sessionIds: string[] }> = [];
    const daemon = await startWith([roots], (event) => {
      calls.push(event);
    });
    const headers = await auth(daemon);
    const created = await createWorkspace(daemon, join(roots, 'app'));
    const insertSession = daemon.db.prepare<[string, string, string]>(
      "INSERT INTO sessions (id, workspace_id, agent, title, status, created_at, updated_at) VALUES (?, ?, 'omp', 'T', ?, 1, 1)",
    );
    insertSession.run('sessao-1', created.id, 'running');
    insertSession.run('sessao-2', created.id, 'stopped');

    const res = await daemon.app.inject({ method: 'DELETE', url: `/api/workspaces/${created.id}`, headers });
    expect(res.statusCode).toBe(204);

    expect(calls).toEqual([{ workspaceId: created.id, sessionIds: ['sessao-1'] }]);
    const statuses = daemon.db.prepare<[], { id: string; status: string }>('SELECT id, status FROM sessions ORDER BY id').all();
    expect(statuses).toEqual([
      { id: 'sessao-1', status: 'stopped' },
      { id: 'sessao-2', status: 'stopped' },
    ]);
  });

  it('DELETE apaga <home>/files/<sessionId> de todas as sessões do workspace, inclusive as paradas', async () => {
    const daemon = await startWith();
    const headers = await auth(daemon);
    const created = await createWorkspace(daemon, join(roots, 'app'));
    const other = await createWorkspace(daemon, join(roots, 'outro'));
    const insertSession = daemon.db.prepare<[string, string, string]>(
      "INSERT INTO sessions (id, workspace_id, agent, title, status, created_at, updated_at) VALUES (?, ?, 'omp', 'T', ?, 1, 1)",
    );
    insertSession.run('sessao-viva', created.id, 'running');
    insertSession.run('sessao-parada', created.id, 'stopped');
    insertSession.run('sessao-outra', other.id, 'running');
    for (const id of ['sessao-viva', 'sessao-parada', 'sessao-outra']) {
      await mkdir(join(daemon.home, 'files', id), { recursive: true });
      await writeFile(join(daemon.home, 'files', id, 'arquivo.png'), 'x');
    }

    const res = await daemon.app.inject({ method: 'DELETE', url: `/api/workspaces/${created.id}`, headers });

    expect(res.statusCode).toBe(204);
    expect(existsSync(join(daemon.home, 'files', 'sessao-viva'))).toBe(false);
    expect(existsSync(join(daemon.home, 'files', 'sessao-parada'))).toBe(false);
    expect(existsSync(join(daemon.home, 'files', 'sessao-outra'))).toBe(true);
  });

  it('DELETE de workspace sem pasta de arquivos responde 204 mesmo assim', async () => {
    const daemon = await startWith();
    const created = await createWorkspace(daemon, join(roots, 'app'));

    const res = await daemon.app.inject({ method: 'DELETE', url: `/api/workspaces/${created.id}`, headers: await auth(daemon) });

    expect(res.statusCode).toBe(204);
  });

  it('todas as rotas de workspace exigem Bearer', async () => {
    const daemon = await startWith();
    expect((await daemon.app.inject({ method: 'GET', url: '/api/workspaces' })).statusCode).toBe(401);
    expect((await daemon.app.inject({ method: 'POST', url: '/api/workspaces', payload: { path: roots } })).statusCode).toBe(
      401,
    );
    expect((await daemon.app.inject({ method: 'DELETE', url: '/api/workspaces/x' })).statusCode).toBe(401);
    expect((await daemon.app.inject({ method: 'GET', url: '/api/workspaces/x/sessions' })).statusCode).toBe(401);
  });
});
