import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionDiffResponseSchema, WorkspaceSchema, type PairResponse, type SessionDiffResponse } from '@nanachi/shared';
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
  base = await realpath(await mkdtemp(join(tmpdir(), 'nanachi-diff-')));
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

/** Workspace na pasta e uma sessão parada nele (inserida direto: não precisa de agente para ler o diff). */
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

async function diffOf(daemon: TestDaemon, sessionId: string, expectedStatus = 200): Promise<SessionDiffResponse> {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/diff`,
    headers: await auth(daemon),
  });
  expect(res.statusCode).toBe(expectedStatus);
  return SessionDiffResponseSchema.parse(res.json<unknown>());
}

function fileNamed(diff: SessionDiffResponse, path: string) {
  const file = diff.files.find((item) => item.path === path);
  if (file === undefined) throw new Error(`arquivo ausente no diff: ${path}`);
  return file;
}

describe('GET /api/sessions/:id/diff', () => {
  it('sessão de pasta que não é git → files vazio e truncated false', async () => {
    const dir = join(roots, 'solto');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'x.txt'), 'x');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    expect(await diffOf(daemon, id)).toEqual({ files: [], truncated: false });
  });

  it('sessão inexistente → 404', async () => {
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/sessions/nao-existe/diff',
      headers: await auth(daemon),
    });
    expect(res.statusCode).toBe(404);
  });

  it('repo com commit: modificado, removido, staged, não rastreado, binário, renomeado', async () => {
    const dir = join(roots, 'app');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    writeIn(dir, 'velho.txt', 'conteudo do velho\n');
    git(dir, 'add', 'velho.txt');
    git(dir, 'commit', '-q', '-m', 'velho');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    writeIn(dir, 'a.txt', 'linha 1\nlinha dois\nlinha 3\nlinha 4\n');
    await rm(join(dir, 'remover.txt'));
    writeIn(dir, 'novo-staged.txt', 'x\n');
    git(dir, 'add', 'novo-staged.txt');
    writeIn(dir, 'solto.txt', 'y\n');
    writeIn(dir, 'bin ção.bin', Buffer.from([0x00, 0x01, 0x02]));
    git(dir, 'mv', 'velho.txt', 'novo.txt');

    const diff = await diffOf(daemon, id);

    expect(diff.truncated).toBe(false);
    expect(diff.files.map((file) => file.path).sort()).toEqual(
      ['a.txt', 'bin ção.bin', 'novo-staged.txt', 'novo.txt', 'remover.txt', 'solto.txt'].sort(),
    );

    const modified = fileNamed(diff, 'a.txt');
    expect(modified).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(modified.patch).toContain('-linha 2');
    expect(modified.patch).toContain('+linha dois');

    expect(fileNamed(diff, 'remover.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 });
    expect(fileNamed(diff, 'novo-staged.txt')).toMatchObject({ status: 'added', additions: 1, deletions: 0 });

    const untracked = fileNamed(diff, 'solto.txt');
    expect(untracked).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(untracked.patch).toContain('diff --git a/solto.txt b/solto.txt');
    expect(untracked.patch).toContain('+y');

    expect(fileNamed(diff, 'bin ção.bin')).toMatchObject({ status: 'added', additions: 0, deletions: 0 });
    expect(fileNamed(diff, 'bin ção.bin').patch).toContain('Binary files');

    const renamed = fileNamed(diff, 'novo.txt');
    expect(renamed.status).toBe('renamed');
    expect(renamed.patch).toContain('rename from velho.txt');
  });

  it('repo sem nenhum commit: tudo que está no índice e os não rastreados contam como added', async () => {
    const dir = join(roots, 'vazio');
    await mkdir(dir, { recursive: true });
    initRepo(dir, { commit: false });
    writeIn(dir, 'a.txt', 'um\n');
    git(dir, 'add', 'a.txt');
    writeIn(dir, 'b.txt', 'dois\n');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const diff = await diffOf(daemon, id);

    expect(diff.files.map((file) => [file.path, file.status])).toEqual([
      ['a.txt', 'added'],
      ['b.txt', 'added'],
    ]);
    expect(diff.truncated).toBe(false);
  });

  it('limite de 1 MiB: patch que não cabe fica vazio, truncated true, e o que cabe ainda vem', async () => {
    const dir = join(roots, 'grande');
    await mkdir(dir, { recursive: true });
    initRepo(dir);
    writeIn(dir, 'rastreado.txt', 'linha\n'.repeat(200_000));
    git(dir, 'add', 'rastreado.txt');
    git(dir, 'commit', '-q', '-m', 'grande');
    writeIn(dir, 'rastreado.txt', 'outra\n'.repeat(200_000));
    writeIn(dir, 'grande-solto.txt', 'linha\n'.repeat(200_000));
    writeIn(dir, 'pequeno-solto.txt', 'oi\n');
    const daemon = await env.start({ config: { allowedRoots: [roots] } });
    const id = await sessionIn(daemon, dir);

    const diff = await diffOf(daemon, id);

    expect(diff.truncated).toBe(true);
    const tracked = fileNamed(diff, 'rastreado.txt');
    expect(tracked).toMatchObject({ status: 'modified', additions: 200_000, deletions: 200_000, patch: '' });
    // Não rastreado acima de 1 MiB não é lido: só o stat. Sem contagem de linhas e sem patch.
    expect(fileNamed(diff, 'grande-solto.txt')).toMatchObject({ status: 'added', additions: 0, patch: '' });
    expect(fileNamed(diff, 'pequeno-solto.txt').patch).toContain('+oi');

    const total = diff.files.reduce((sum, file) => sum + Buffer.byteLength(file.patch, 'utf8'), 0);
    expect(total).toBeLessThanOrEqual(DIFF_MAX_BYTES);
  });
});
