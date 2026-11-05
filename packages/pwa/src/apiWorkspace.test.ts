import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './api.js';

const BASE = 'http://100.64.0.1:7777';

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: () => Response) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, fetchFn };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(respond: () => Response) {
  const fake = fakeFetch(respond);
  const client = createApiClient({ baseUrl: BASE, token: 'tok' }, fake.fetchFn);
  return { client, calls: fake.calls };
}

const BRANCHES = {
  isRepo: true,
  current: 'main',
  detachedAt: null,
  branches: [{ name: 'main', current: true, upstream: 'origin/main', lastCommitAt: 1_700_000_000_000 }],
  dirty: [],
};

const FILE = {
  path: 'src/app.ts',
  content: 'export const a = 1;\n',
  encoding: 'utf8',
  size: 20,
  mtimeMs: 1_700_000_000_000,
  etag: 'e1',
};

describe('git do workspace', () => {
  it('lista as branches com GET no workspace', async () => {
    const { client, calls } = clientWith(() => json(BRANCHES));
    const result = await client.gitBranches('w-1');
    expect(result).toMatchObject({ isRepo: true, current: 'main' });
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/git/branches`);
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('checkout manda o nome e create no corpo', async () => {
    const { client, calls } = clientWith(() => json(BRANCHES));
    await client.gitCheckout('w-1', { branch: 'feat/x', create: true });
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/git/checkout`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ branch: 'feat/x', create: true });
  });

  it('checkout recusa nome que começa com "-" sem tocar na rede', async () => {
    const { client, calls } = clientWith(() => json(BRANCHES));
    await expect(client.gitCheckout('w-1', { branch: '-x' })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('409 dirty_worktree guarda a lista de arquivos sujos em details', async () => {
    const { client } = clientWith(() =>
      json({ error: 'dirty_worktree', details: { dirty: ['a.ts', ' M b.ts'] } }, 409),
    );
    const error = await client.gitCheckout('w-1', { branch: 'main' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'dirty_worktree', status: 409 });
    expect((error as ApiError).details).toEqual({ dirty: ['a.ts', ' M b.ts'] });
  });

  it('pasta que não é git: 200 { isRepo: false }, sem erro (a troca de branch some sem console de erro)', async () => {
    const { client } = clientWith(() => json({ isRepo: false }));
    const result = await client.gitBranches('w-1');
    expect(result).toEqual({ isRepo: false });
  });

  it('checkout fora de um repositório continua com 400 not_a_git_repo', async () => {
    const { client } = clientWith(() => json({ error: 'not_a_git_repo' }, 400));
    const error = await client.gitCheckout('w-1', { branch: 'main' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'not_a_git_repo', status: 400 });
  });
});

describe('arquivos do workspace', () => {
  it('lista um diretório com o caminho codificado na query', async () => {
    const { client, calls } = clientWith(() =>
      json({ entries: [{ name: 'a b.ts', type: 'file', size: 3, mtimeMs: 1, ignored: false }] }),
    );
    const entries = await client.fsList('w-1', 'src/a b');
    expect(entries[0]?.name).toBe('a b.ts');
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/fs/list?path=src%2Fa+b`);
  });

  it('a raiz vai como path vazio', async () => {
    const { client, calls } = clientWith(() => json({ entries: [] }));
    await client.fsList('w-1', '');
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/fs/list?path=`);
  });

  it('lê um arquivo de texto', async () => {
    const { client, calls } = clientWith(() => json(FILE));
    const file = await client.fsReadFile('w-1', 'src/app.ts');
    expect(file.etag).toBe('e1');
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/fs/file?path=src%2Fapp.ts`);
  });

  it('415 binary_file vira erro com o código', async () => {
    const { client } = clientWith(() => json({ error: 'binary_file' }, 415));
    const error = await client.fsReadFile('w-1', 'logo.png').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'binary_file', status: 415 });
  });

  it('salva com PUT e baseEtag no corpo', async () => {
    const { client, calls } = clientWith(() => json({ path: 'src/app.ts', size: 3, mtimeMs: 2, etag: 'e2' }));
    const result = await client.fsWriteFile('w-1', { path: 'src/app.ts', content: 'x', baseEtag: 'e1' });
    expect(result.etag).toBe('e2');
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/fs/file`);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ path: 'src/app.ts', content: 'x', baseEtag: 'e1' });
  });

  it('arquivo novo manda baseEtag null', async () => {
    const { client, calls } = clientWith(() => json({ path: 'n.ts', size: 0, mtimeMs: 2, etag: 'e0' }));
    await client.fsWriteFile('w-1', { path: 'n.ts', content: '', baseEtag: null });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ baseEtag: null });
  });

  it('409 file_changed guarda o etag atual em details', async () => {
    const { client } = clientWith(() => json({ error: 'file_changed', details: { etag: 'e9' } }, 409));
    const error = await client
      .fsWriteFile('w-1', { path: 'src/app.ts', content: 'x', baseEtag: 'e1' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'file_changed', status: 409 });
    expect((error as ApiError).details).toEqual({ etag: 'e9' });
  });

  it('413 file_too_large mapeia para too_large com o código', async () => {
    const { client } = clientWith(() => json({ error: 'file_too_large' }, 413));
    const error = await client.fsReadFile('w-1', 'big.log').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'too_large', code: 'file_too_large' });
  });

  it('cria pasta com POST em mkdir', async () => {
    const { client, calls } = clientWith(() => json({ path: 'nova' }, 201));
    await client.fsMkdir('w-1', 'nova');
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/fs/mkdir`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ path: 'nova' });
  });

  it('renomeia com POST em rename', async () => {
    const { client, calls } = clientWith(() => json({ from: 'a', to: 'b' }));
    await client.fsRename('w-1', 'a', 'b');
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/fs/rename`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ from: 'a', to: 'b' });
  });

  it('exclui com DELETE no entry, com o caminho na query', async () => {
    const { client, calls } = clientWith(() => new Response(null, { status: 204 }));
    await client.fsDelete('w-1', 'src/old.ts');
    expect(calls[0]?.url).toBe(`${BASE}/api/workspaces/w-1/fs/entry?path=src%2Fold.ts`);
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('409 dir_not_empty chega com o código', async () => {
    const { client } = clientWith(() => json({ error: 'dir_not_empty' }, 409));
    const error = await client.fsDelete('w-1', 'src').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'dir_not_empty', status: 409 });
  });
});
