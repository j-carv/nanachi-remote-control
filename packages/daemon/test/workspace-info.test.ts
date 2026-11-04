import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceInfoResponseSchema, WorkspaceSchema, type PairResponse, type Workspace } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueCode, setupDaemonTests, type TestDaemon } from './support.js';
import { git, initRepo, writeIn } from './git-support.js';
import { removeTempDir } from './temp.js';

const env = setupDaemonTests();

let base: string;
let roots: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'nanachi-info-')));
  roots = join(base, 'projetos');
  await mkdir(roots);
});

afterEach(async () => {
  await removeTempDir(base);
});

async function auth(daemon: TestDaemon): Promise<{ authorization: string }> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/pair',
    payload: { code: issueCode(daemon), deviceName: 'iPhone' },
  });
  return { authorization: `Bearer ${res.json<PairResponse>().token}` };
}

/** Cria o workspace pela API (a pasta precisa estar nas raízes permitidas). */
async function workspaceAt(daemon: TestDaemon, path: string): Promise<Workspace> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await auth(daemon),
    payload: { path },
  });
  return WorkspaceSchema.parse(res.json<unknown>());
}

async function infoOf(daemon: TestDaemon, workspaceId: string) {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/workspaces/${workspaceId}/info`,
    headers: await auth(daemon),
  });
  expect(res.statusCode).toBe(200);
  return WorkspaceInfoResponseSchema.parse(res.json<unknown>());
}

describe('GET /api/workspaces/:id/info', () => {
  it('pasta sem git: branch e changedFiles são null e instructions lista só os arquivos que existem', async () => {
    const dir = join(roots, 'solto');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'CLAUDE.md'), '# regras');
    await writeFile(join(dir, 'GEMINI.md'), '# gemini');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const workspace = await workspaceAt(daemon, dir);

    expect(await infoOf(daemon, workspace.id)).toEqual({
      branch: null,
      changedFiles: null,
      instructions: ['CLAUDE.md', 'GEMINI.md'],
    });
  });

  it('repo com commit: branch atual e nº de arquivos alterados (modificado, removido, staged, não rastreado)', async () => {
    const dir = join(roots, 'app');
    await mkdir(dir, { recursive: true });
    initRepo(dir, { branch: 'trabalho' });
    writeIn(dir, 'AGENTS.md', '# agentes');
    git(dir, 'add', 'AGENTS.md');
    git(dir, 'commit', '-q', '-m', 'agentes');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const workspace = await workspaceAt(daemon, dir);

    writeIn(dir, 'a.txt', 'mudou\n');
    git(dir, 'rm', '-q', 'remover.txt');
    writeIn(dir, 'novo-staged.txt', 'x\n');
    git(dir, 'add', 'novo-staged.txt');
    writeIn(dir, 'solto.txt', 'y\n');

    expect(await infoOf(daemon, workspace.id)).toEqual({
      branch: 'trabalho',
      changedFiles: 4,
      instructions: ['AGENTS.md'],
    });
  });

  it('repo sem nenhum commit: branch é o nome da branch inicial e os arquivos novos contam', async () => {
    const dir = join(roots, 'vazio');
    await mkdir(dir, { recursive: true });
    initRepo(dir, { commit: false, branch: 'inicio' });
    writeIn(dir, 'a.txt', 'x\n');
    git(dir, 'add', 'a.txt');
    writeIn(dir, 'b.txt', 'y\n');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const workspace = await workspaceAt(daemon, dir);

    expect(await infoOf(daemon, workspace.id)).toEqual({
      branch: 'inicio',
      changedFiles: 2,
      instructions: [],
    });
  });

  it('HEAD destacado (sem branch): branch null', async () => {
    const dir = join(roots, 'destacado');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    git(dir, 'checkout', '-q', '--detach');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const workspace = await workspaceAt(daemon, dir);

    expect((await infoOf(daemon, workspace.id)).branch).toBeNull();
  });

  it('workspace inexistente → 404', async () => {
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/workspaces/nao-existe/info',
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(404);
  });

  it('sem Bearer → 401', async () => {
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/workspaces/x/info' });
    expect(res.statusCode).toBe(401);
  });
});
