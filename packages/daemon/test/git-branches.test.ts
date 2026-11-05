import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitBranchesResponseSchema, type GitBranchesRepo } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertSession, updateSession } from '../src/repository.js';
import { authHeader, createWorkspace } from './agent-support.js';
import { git, initRepo, writeIn } from './git-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let root: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-branches-')));
  root = join(base, 'projeto');
  await mkdir(root);
  initRepo(root);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registered before the daemons: its afterEach runs last.
const env = setupDaemonTests();

async function start(): Promise<{ daemon: TestDaemon; id: string; token: string }> {
  const daemon = await env.start({ config: { allowedRoots: [base] } });
  const token = (await authHeader(daemon)).authorization;
  const id = await createWorkspace(daemon, root);
  return { daemon, id, token };
}

function branchesUrl(id: string): string {
  return `/api/workspaces/${id}/git/branches`;
}

function checkoutUrl(id: string): string {
  return `/api/workspaces/${id}/git/checkout`;
}

async function getBranches(daemon: TestDaemon, id: string, token: string): Promise<GitBranchesRepo> {
  const res = await daemon.app.inject({ method: 'GET', url: branchesUrl(id), headers: { authorization: token } });
  expect(res.statusCode).toBe(200);
  const body = GitBranchesResponseSchema.parse(res.json<unknown>());
  if (!body.isRepo) throw new Error('a pasta de teste deveria ser um repositório git');
  return body;
}

async function checkout(daemon: TestDaemon, id: string, token: string, payload: object) {
  return daemon.app.inject({ method: 'POST', url: checkoutUrl(id), headers: { authorization: token }, payload });
}

/** Current branch read straight from git (the source of truth the API is compared against). */
function gitCurrentBranch(dir: string): string {
  return git(dir, 'symbolic-ref', '--short', 'HEAD').trim();
}

describe('GET git/branches', () => {
  it('lista a branch atual, as locais, sem upstream e sem alterações num repositório limpo', async () => {
    const { daemon, id, token } = await start();
    const body = await getBranches(daemon, id, token);
    expect(body.current).toBe('main');
    expect(body.detachedAt).toBeNull();
    expect(body.dirty).toEqual([]);
    expect(body.branches).toHaveLength(1);
    expect(body.branches[0]).toMatchObject({ name: 'main', current: true, upstream: null });
    // Commit date in ms (not seconds): anything after the year 2000.
    expect(body.branches[0]?.lastCommitAt).toBeGreaterThan(946_684_800_000);
  });

  it('mostra o upstream quando a branch rastreia um remoto', async () => {
    const { daemon, id, token } = await start();
    const remote = join(base, 'remoto.git');
    git(base, 'init', '--bare', '-q', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-q', '-u', 'origin', 'main');
    const body = await getBranches(daemon, id, token);
    expect(body.branches[0]?.upstream).toBe('origin/main');
  });

  it('HEAD destacado: current null e detachedAt com o commit abreviado', async () => {
    const { daemon, id, token } = await start();
    git(root, 'checkout', '-q', '--detach');
    const short = git(root, 'rev-parse', '--short', 'HEAD').trim();
    const body = await getBranches(daemon, id, token);
    expect(body.current).toBeNull();
    expect(body.detachedAt).toBe(short);
    expect(body.branches.every((branch) => branch.current === false)).toBe(true);
  });

  it('alterações: modificado, não rastreado e no índice aparecem; ignorado não', async () => {
    const { daemon, id, token } = await start();
    await writeFile(join(root, '.gitignore'), '*.log\n');
    git(root, 'add', '.gitignore');
    git(root, 'commit', '-q', '-m', 'ignore');
    await writeFile(join(root, 'a.txt'), 'mudou\n');
    await writeFile(join(root, 'novo.md'), 'novo\n');
    await writeFile(join(root, 'erro.log'), 'ignorado\n');
    writeIn(root, 'pasta/x.ts', 'x');
    git(root, 'add', 'pasta/x.ts');

    const body = await getBranches(daemon, id, token);
    expect(body.dirty).toEqual(expect.arrayContaining(['a.txt', 'novo.md', 'pasta/x.ts']));
    expect(body.dirty).not.toContain('erro.log');
  });

  it('dirty é limitado a 200 caminhos', async () => {
    const { daemon, id, token } = await start();
    for (let i = 0; i < 205; i++) {
      await writeFile(join(root, `f${String(i).padStart(3, '0')}.txt`), 'x');
    }
    const body = await getBranches(daemon, id, token);
    expect(body.dirty).toHaveLength(200);
  });

  it('pasta que não é git → 200 { isRepo: false }; workspace inexistente → 404', async () => {
    const { daemon, token } = await start();
    const plain = join(base, 'sem-git');
    await mkdir(plain);
    const plainId = await createWorkspace(daemon, plain);
    const res = await daemon.app.inject({ method: 'GET', url: branchesUrl(plainId), headers: { authorization: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ isRepo: false });

    const missing = await daemon.app.inject({ method: 'GET', url: branchesUrl('nao-existe'), headers: { authorization: token } });
    expect(missing.statusCode).toBe(404);
  });

  it('sem Bearer → 401', async () => {
    const { daemon, id } = await start();
    const res = await daemon.app.inject({ method: 'GET', url: branchesUrl(id) });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST git/checkout', () => {
  it('pasta que não é git → 400 not_a_git_repo (troca de branch continua exigindo repositório)', async () => {
    const { daemon, token } = await start();
    const plain = join(base, 'sem-git-checkout');
    await mkdir(plain);
    const plainId = await createWorkspace(daemon, plain);
    const res = await checkout(daemon, plainId, token, { branch: 'main' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'not_a_git_repo' });
  });

  it('create cria a branch e troca para ela; a resposta é o estado novo', async () => {
    const { daemon, id, token } = await start();
    const res = await checkout(daemon, id, token, { branch: 'feature/x', create: true });
    expect(res.statusCode).toBe(200);
    const body = GitBranchesResponseSchema.parse(res.json<unknown>());
    if (!body.isRepo) throw new Error('resposta deveria ser de repositório');
    expect(body.current).toBe('feature/x');
    expect(body.branches.map((branch) => branch.name).sort()).toEqual(['feature/x', 'main']);
    expect(gitCurrentBranch(root)).toBe('feature/x');
  });

  it('troca para branch existente (sem create)', async () => {
    const { daemon, id, token } = await start();
    git(root, 'branch', 'outra');
    const res = await checkout(daemon, id, token, { branch: 'outra' });
    expect(res.statusCode).toBe(200);
    expect(gitCurrentBranch(root)).toBe('outra');

    const back = await checkout(daemon, id, token, { branch: 'main' });
    expect(back.json<GitBranchesRepo>().current).toBe('main');
  });

  it('sem create, branch que não existe localmente → 404 branch_not_found (não cria)', async () => {
    const { daemon, id, token } = await start();
    const res = await checkout(daemon, id, token, { branch: 'nao-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'branch_not_found' });
    expect(gitCurrentBranch(root)).toBe('main');
  });

  it('create com nome de branch que já existe → 409 branch_exists', async () => {
    const { daemon, id, token } = await start();
    git(root, 'branch', 'ja-existe');
    const res = await checkout(daemon, id, token, { branch: 'ja-existe', create: true });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'branch_exists' });
  });

  it('alterações não commitadas → 409 dirty_worktree com a lista; HEAD não muda', async () => {
    const { daemon, id, token } = await start();
    git(root, 'branch', 'outra');
    await writeFile(join(root, 'a.txt'), 'sujo\n');
    await writeFile(join(root, 'nao-rastreado.md'), 'x\n');

    const res = await checkout(daemon, id, token, { branch: 'outra' });
    expect(res.statusCode).toBe(409);
    const body = res.json<{ error: string; details: { dirty: string[] } }>();
    expect(body.error).toBe('dirty_worktree');
    expect(body.details.dirty).toEqual(expect.arrayContaining(['a.txt', 'nao-rastreado.md']));
    expect(gitCurrentBranch(root)).toBe('main');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('sujo\n');
  });

  it('sessão do workspace rodando (running, starting ou awaiting_permission) → 409 sessions_running', async () => {
    const { daemon, id, token } = await start();
    git(root, 'branch', 'outra');
    for (const status of ['starting', 'running', 'awaiting_permission'] as const) {
      const sessionId = `s-${status}`;
      insertSession(daemon.db, { id: sessionId, workspaceId: id, agent: 'fake', title: 't', status, createdAt: Date.now() });
      const res = await checkout(daemon, id, token, { branch: 'outra' });
      expect(res.json(), status).toEqual({ error: 'sessions_running' });
      updateSession(daemon.db, sessionId, { status: 'stopped' }, Date.now());
    }
    expect(gitCurrentBranch(root)).toBe('main');
  });

  it('sessão parada, com erro ou ociosa não bloqueia a troca', async () => {
    const { daemon, id, token } = await start();
    git(root, 'branch', 'outra');
    insertSession(daemon.db, { id: 'parada', workspaceId: id, agent: 'fake', title: 't', status: 'stopped', createdAt: 1 });
    insertSession(daemon.db, { id: 'erro', workspaceId: id, agent: 'fake', title: 't', status: 'error', createdAt: 2 });
    insertSession(daemon.db, { id: 'ociosa', workspaceId: id, agent: 'fake', title: 't', status: 'idle', createdAt: 3 });
    const res = await checkout(daemon, id, token, { branch: 'outra' });
    expect(res.statusCode).toBe(200);
  });

  it('nomes inválidos: zod recusa hífen inicial e @{; git recusa o resto → 400', async () => {
    const { daemon, id, token } = await start();
    const invalidRequest = ['-x', '--force', '@{-1}', ''];
    for (const branch of invalidRequest) {
      const res = await checkout(daemon, id, token, { branch, create: true });
      expect(res.json(), branch).toEqual({ error: 'invalid_request' });
    }
    const invalidBranch = ['a..b', 'a b', 'x.lock', 'a/', 'a~1', 'a^', 'a:b', 'a?b', 'fim.'];
    for (const branch of invalidBranch) {
      const res = await checkout(daemon, id, token, { branch, create: true });
      expect(res.statusCode, branch).toBe(400);
      expect(res.json(), branch).toEqual({ error: 'invalid_branch' });
    }
    expect(gitCurrentBranch(root)).toBe('main');
  });

  it('corpo ausente ou sem branch → 400 invalid_request', async () => {
    const { daemon, id, token } = await start();
    const none = await daemon.app.inject({ method: 'POST', url: checkoutUrl(id), headers: { authorization: token } });
    expect(none.json()).toEqual({ error: 'invalid_request' });
    const wrong = await checkout(daemon, id, token, { create: true });
    expect(wrong.json()).toEqual({ error: 'invalid_request' });
  });

  it('branch aberta em outro worktree → 409 branch_in_use', async () => {
    const { daemon, id, token } = await start();
    git(root, 'branch', 'em-uso');
    const wt = join(base, 'wt-em-uso');
    git(root, 'worktree', 'add', '-q', wt, 'em-uso');

    const res = await checkout(daemon, id, token, { branch: 'em-uso' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'branch_in_use' });
    expect(gitCurrentBranch(root)).toBe('main');
  });

  it('workspace que é um worktree troca só o próprio worktree', async () => {
    const { daemon, id, token } = await start();
    git(root, 'branch', 'nos-wt');
    const wt = join(base, 'wt-proprio');
    git(root, 'worktree', 'add', '-q', wt, 'nos-wt');
    const wtId = await createWorkspace(daemon, wt);

    const branches = await getBranches(daemon, wtId, token);
    expect(branches.current).toBe('nos-wt');

    const res = await checkout(daemon, wtId, token, { branch: 'novo-no-wt', create: true });
    expect(res.statusCode).toBe(200);
    expect(gitCurrentBranch(wt)).toBe('novo-no-wt');
    expect(gitCurrentBranch(root)).toBe('main');
    // The main workspace stays on main, and the branch created in the worktree shows up in its list.
    const main = await getBranches(daemon, id, token);
    expect(main.branches.map((branch) => branch.name)).toContain('novo-no-wt');
  });

  it('sem Bearer → 401', async () => {
    const { daemon, id } = await start();
    const res = await daemon.app.inject({ method: 'POST', url: checkoutUrl(id), payload: { branch: 'x', create: true } });
    expect(res.statusCode).toBe(401);
  });
});
