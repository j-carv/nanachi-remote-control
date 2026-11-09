import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionCommitResponseSchema,
  SessionCommitsResponseSchema,
  WorkspaceSchema,
  type PairResponse,
  type SessionCommitResponse,
  type SessionCommitsResponse,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertSession } from '../src/repository.js';
import { DIFF_MAX_BYTES } from '../src/session-diff.js';
import { git, initRepo, writeIn } from './git-support.js';
import { issueCode, setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

const env = setupDaemonTests();

let base: string;
let roots: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'nanachi-commits-')));
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

/** Workspace na pasta e uma sessão parada nele (inserida direto: não precisa de agente para ler o histórico). */
async function sessionIn(daemon: TestDaemon, path: string): Promise<string> {
  const workspaceRes = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await auth(daemon),
    payload: { path },
  });
  const workspace = WorkspaceSchema.parse(workspaceRes.json<unknown>());
  const id = randomUUID();
  insertSession(daemon.db, {
    id,
    workspaceId: workspace.id,
    agent: 'omp',
    title: 'Teste',
    status: 'idle',
    createdAt: Date.now(),
  });
  return id;
}

async function listOf(daemon: TestDaemon, sessionId: string, query = '', expectedStatus = 200): Promise<SessionCommitsResponse> {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/commits${query}`,
    headers: await auth(daemon),
  });
  expect(res.statusCode).toBe(expectedStatus);
  return SessionCommitsResponseSchema.parse(res.json<unknown>());
}

async function commitOf(daemon: TestDaemon, sessionId: string, ref: string, expectedStatus = 200): Promise<SessionCommitResponse> {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/commits/${ref}`,
    headers: await auth(daemon),
  });
  expect(res.statusCode).toBe(expectedStatus);
  return SessionCommitResponseSchema.parse(res.json<unknown>());
}

/** Commit de um arquivo com a mensagem dada (`-m` aceita quebras de linha). */
function commitFile(dir: string, path: string, content: string, message: string): void {
  writeIn(dir, path, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/**
 * Adds `count` commits on the repository's branch in ONE `git fast-import` process, fed from stdin. A `git commit` per
 * commit costs two process spawns each, which made the paging test exceed its timeout under load. Each commit adds one
 * file, with a fixed author and an increasing date, so the history is the same on every run.
 */
function addCommitsInOneProcess(dir: string, count: number): void {
  const tip = headOf(dir);
  let stream = '';
  for (let i = 0; i < count; i++) {
    const message = `commit ${i}`;
    const content = `${i}\n`;
    const when = 1_700_000_000 + i;
    stream += 'commit refs/heads/main\n';
    stream += `author teste <teste@exemplo.com> ${when} +0000\n`;
    stream += `committer teste <teste@exemplo.com> ${when} +0000\n`;
    stream += `data ${Buffer.byteLength(message)}\n${message}\n`;
    // Without `from`, fast-import starts a new root history and refuses to move the branch (not a fast-forward). The
    // first commit names the current tip by its id (a `from` naming the branch itself is refused); the rest chain.
    if (i === 0) stream += `from ${tip}\n`;
    stream += `M 100644 inline f${i}.txt\n`;
    stream += `data ${Buffer.byteLength(content)}\n${content}\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream, encoding: 'utf8', windowsHide: true });
}

function headOf(dir: string): string {
  return git(dir, 'rev-parse', 'HEAD').trim();
}

function fileNamed(commit: SessionCommitResponse, path: string) {
  const file = commit.files.find((item) => item.path === path);
  if (file === undefined) throw new Error(`arquivo ausente no commit: ${path}`);
  return file;
}

describe('GET /api/sessions/:id/commits', () => {
  it('pasta que não é git → lista vazia e hasMore false', async () => {
    const dir = join(roots, 'solto');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'x.txt'), 'x');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    expect(await listOf(daemon, id)).toEqual({ commits: [], hasMore: false });
  });

  it('repositório sem nenhum commit → lista vazia e hasMore false', async () => {
    const dir = join(roots, 'vazio');
    await mkdir(dir, { recursive: true });
    initRepo(dir, { commit: false });
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    expect(await listOf(daemon, id)).toEqual({ commits: [], hasMore: false });
  });

  it('lista do mais novo para o mais antigo; summary é a primeira linha não vazia do corpo', async () => {
    const dir = join(roots, 'app');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    commitFile(dir, 'b.txt', 'b\n', 'segundo\n\n\n  corpo linha 1  \nlinha 2');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const page = await listOf(daemon, id);

    expect(page.hasMore).toBe(false);
    expect(page.commits.map((commit) => commit.subject)).toEqual(['segundo', 'inicial']);
    const [newest, oldest] = page.commits;
    expect(newest).toMatchObject({
      hash: headOf(dir),
      subject: 'segundo',
      summary: 'corpo linha 1',
      author: 'teste',
    });
    expect(headOf(dir).startsWith(newest?.shortHash ?? '!')).toBe(true);
    expect(oldest).toMatchObject({ subject: 'inicial', summary: null, author: 'teste' });
    expect(Math.abs(Date.now() - (newest?.date ?? 0))).toBeLessThan(120_000);
  });

  it('pagina com skip e limit, e hasMore só é true quando há mais commits', async () => {
    const dir = join(roots, 'paginas');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    commitFile(dir, 'b.txt', 'b\n', 'dois');
    commitFile(dir, 'c.txt', 'c\n', 'tres');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const first = await listOf(daemon, id, '?limit=2');
    expect(first.commits.map((commit) => commit.subject)).toEqual(['tres', 'dois']);
    expect(first.hasMore).toBe(true);

    const second = await listOf(daemon, id, '?skip=2&limit=2');
    expect(second.commits.map((commit) => commit.subject)).toEqual(['inicial']);
    expect(second.hasMore).toBe(false);

    expect(await listOf(daemon, id, '?skip=3')).toEqual({ commits: [], hasMore: false });
  });

  it('limite padrão de 30 e máximo de 100', async () => {
    const dir = join(roots, 'muitos');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    addCommitsInOneProcess(dir, 31);
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const byDefault = await listOf(daemon, id);
    expect(byDefault.commits).toHaveLength(30);
    expect(byDefault.hasMore).toBe(true);
    expect((await listOf(daemon, id, '?limit=100')).commits).toHaveLength(32);
  });

  it.each(['?skip=-1', '?skip=abc', '?skip=1.5', '?limit=0', '?limit=101', '?limit=abc', '?skip=3000000000'])(
    'parâmetro inválido %s → 400 invalid_request',
    async (query) => {
      const dir = join(roots, 'parametros');
      await mkdir(dir, { recursive: true });
      initRepo(dir);
      const daemon = await env.start({ config: { allowedRoots: [roots] } });
      const id = await sessionIn(daemon, dir);

      const res = await daemon.app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/commits${query}`,
        headers: await auth(daemon),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_request' });
    },
  );

  it('sessão inexistente → 404', async () => {
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/sessions/nao-existe/commits',
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/sessions/:id/commits/:hash', () => {
  it('commit raiz: arquivos aparecem como added, com patch, e o corpo sai aparado', async () => {
    const dir = join(roots, 'raiz');
    await mkdir(dir, { recursive: true });
    initRepo(dir, { commit: false });
    commitFile(dir, 'a.txt', 'um\ndois\n', 'inicial\n\nprimeira linha do corpo\n');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const commit = await commitOf(daemon, id, headOf(dir));

    expect(commit).toMatchObject({
      hash: headOf(dir),
      subject: 'inicial',
      body: 'primeira linha do corpo',
      author: 'teste',
      truncated: false,
    });
    expect(commit.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ['a.txt', 'added', 2, 0],
    ]);
    expect(fileNamed(commit, 'a.txt').patch).toContain('+dois');
  });

  it('commit comum: compara com o pai, com modificado, removido e renomeado', async () => {
    const dir = join(roots, 'comum');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    writeIn(dir, 'a.txt', 'linha 1\nlinha dois\nlinha 3\n');
    await rm(join(dir, 'remover.txt'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'mudanca\n\nalterou a linha 2 e removeu um arquivo');
    const modifiedHash = headOf(dir);
    git(dir, 'mv', 'a.txt', 'novo.txt');
    git(dir, 'commit', '-q', '-m', 'renomeia');
    const renamedHash = headOf(dir);
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const modified = await commitOf(daemon, id, modifiedHash);
    expect(modified.body).toBe('alterou a linha 2 e removeu um arquivo');
    expect(fileNamed(modified, 'a.txt')).toMatchObject({ status: 'modified', additions: 1, deletions: 1 });
    expect(fileNamed(modified, 'a.txt').patch).toContain('+linha dois');
    expect(fileNamed(modified, 'remover.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });

    const renamed = await commitOf(daemon, id, renamedHash);
    expect(renamed.body).toBe('');
    expect(renamed.files).toHaveLength(1);
    expect(fileNamed(renamed, 'novo.txt').status).toBe('renamed');
    expect(fileNamed(renamed, 'novo.txt').patch).toContain('rename from a.txt');
  });

  it('commit de merge é comparado com o primeiro pai (só o que a branch trouxe)', async () => {
    const dir = join(roots, 'merge');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile(dir, 'feat.txt', 'feature\n', 'feature');
    git(dir, 'checkout', '-q', 'main');
    commitFile(dir, 'main.txt', 'main\n', 'main');
    git(dir, 'merge', '--no-ff', '-q', 'feature', '-m', 'merge feature');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const merge = await commitOf(daemon, id, headOf(dir));

    expect(merge.files.map((file) => [file.path, file.status])).toEqual([['feat.txt', 'added']]);
  });

  it('aceita o hash abreviado de 7 caracteres e devolve o completo', async () => {
    const dir = join(roots, 'curto');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const commit = await commitOf(daemon, id, headOf(dir).slice(0, 7));
    expect(commit.hash).toBe(headOf(dir));
  });

  it('arquivo que passa do limite de 1 MiB: patch vazio e truncated true, o que cabe ainda vem', async () => {
    const dir = join(roots, 'grande');
    await mkdir(dir, { recursive: true });
    initRepo(dir, { commit: false });
    writeIn(dir, 'grande.txt', 'linha\n'.repeat(200_000));
    writeIn(dir, 'pequeno.txt', 'oi\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'grande');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const commit = await commitOf(daemon, id, headOf(dir));

    expect(commit.truncated).toBe(true);
    expect(fileNamed(commit, 'grande.txt')).toMatchObject({ status: 'added', additions: 200_000, patch: '' });
    expect(fileNamed(commit, 'pequeno.txt').patch).toContain('+oi');
    const total = commit.files.reduce((sum, file) => sum + Buffer.byteLength(file.patch, 'utf8'), 0);
    expect(total).toBeLessThanOrEqual(DIFF_MAX_BYTES);
  });

  it.each(['XYZ', 'af938', 'AF9384E', 'g1234567'])('hash %s fora do formato → 400 invalid_request', async (ref) => {
    const dir = join(roots, 'formato');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/commits/${ref}`,
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_request' });
  });

  it('hash bem formado que não existe no repositório → 404 not_found', async () => {
    const dir = join(roots, 'desconhecido');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/sessions/${id}/commits/deadbeef`,
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('repositório sem commit, pasta que não é git e sessão inexistente → 404', async () => {
    const empty = join(roots, 'vazio');
    await mkdir(empty, { recursive: true });
    initRepo(empty, { commit: false });
    const plain = join(roots, 'solto');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'x.txt'), 'x');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const emptyId = await sessionIn(daemon, empty);
    const plainId = await sessionIn(daemon, plain);

    for (const id of [emptyId, plainId, 'nao-existe']) {
      const res = await daemon.app.inject({
        method: 'GET',
        url: `/api/sessions/${id}/commits/deadbeef`,
        headers: await auth(daemon),
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
