import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './api.js';

const SESSION = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'omp',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'idle',
  worktree: { path: 'C:\\app\\.nanachi\\wt', branch: 'nanachi/s1' },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchFn };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchFn: FetchLike) {
  return createApiClient({ baseUrl: 'http://127.0.0.1:7777/', token: 'tok-1' }, fetchFn);
}

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('esperava ApiError');
}

describe('createApiClient: contexto do workspace', () => {
  it('workspaceInfo faz GET em /info e valida (git com branch)', async () => {
    const info = { branch: 'main', changedFiles: 3, instructions: ['CLAUDE.md'] };
    const { calls, fetchFn } = fakeFetch(() => json(info));
    expect(await clientWith(fetchFn).workspaceInfo('w-1')).toEqual(info);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/workspaces/w-1/info');
  });

  it('workspaceInfo aceita não-git (branch e changedFiles null)', async () => {
    const info = { branch: null, changedFiles: null, instructions: [] };
    const { fetchFn } = fakeFetch(() => json(info));
    expect(await clientWith(fetchFn).workspaceInfo('w-1')).toEqual(info);
  });

  it('workspaceInfo com id vazio nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({}));
    const error = await errorOf(clientWith(fetchFn).workspaceInfo(''));
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});

describe('createApiClient: diff da sessão', () => {
  it('sessionDiff faz GET em /diff e valida arquivos e patch', async () => {
    const body = {
      files: [
        {
          path: 'src/a.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          patch: '@@ -1 +1 @@\n-a\n+b\n',
        },
      ],
      truncated: false,
    };
    const { calls, fetchFn } = fakeFetch(() => json(body));
    expect(await clientWith(fetchFn).sessionDiff('s-1')).toEqual(body);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/diff');
  });

  it('sessionDiff com status fora do enum vira unexpected', async () => {
    const body = {
      files: [{ path: 'a', status: 'copied', additions: 0, deletions: 0, patch: '' }],
      truncated: false,
    };
    const { fetchFn } = fakeFetch(() => json(body));
    const error = await errorOf(clientWith(fetchFn).sessionDiff('s-1'));
    expect(error.kind).toBe('unexpected');
  });
});

describe('createApiClient: histórico de commits', () => {
  const HASH = 'af9384ef96648594f13a8bd80ae53aa3e830a8ae';
  const entry = {
    hash: HASH,
    shortHash: 'af9384e',
    subject: 'segundo',
    summary: 'corpo linha 1',
    author: 'teste',
    date: 1_793_935_007_000,
  };

  it('sessionCommits faz GET em /commits com skip e limit e valida a página', async () => {
    const body = { commits: [entry], hasMore: true };
    const { calls, fetchFn } = fakeFetch(() => json(body));
    expect(await clientWith(fetchFn).sessionCommits('s-1', { skip: 30, limit: 30 })).toEqual(body);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/commits?skip=30&limit=30');
  });

  it('sessionCommits com commit fora do formato vira unexpected', async () => {
    const body = { commits: [{ ...entry, date: 1.5 }], hasMore: false };
    const { fetchFn } = fakeFetch(() => json(body));
    const error = await errorOf(clientWith(fetchFn).sessionCommits('s-1', { skip: 0, limit: 30 }));
    expect(error.kind).toBe('unexpected');
  });

  it('sessionCommit faz GET no hash e valida arquivos e patch', async () => {
    const body = {
      hash: HASH,
      shortHash: 'af9384e',
      subject: 'segundo',
      body: 'corpo linha 1\nlinha 2',
      author: 'teste',
      date: 1_793_935_007_000,
      files: [{ path: 'a.txt', status: 'renamed', additions: 0, deletions: 0, patch: 'rename from b.txt\n' }],
      truncated: false,
    };
    const { calls, fetchFn } = fakeFetch(() => json(body));
    expect(await clientWith(fetchFn).sessionCommit('s-1', HASH)).toEqual(body);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:7777/api/sessions/s-1/commits/${HASH}`);
  });

  it('sessionCommit com hash fora do formato nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({}));
    const error = await errorOf(clientWith(fetchFn).sessionCommit('s-1', 'AF9384E; rm'));
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('sessionCommit de commit que não existe vira not_found', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'not_found' }, 404));
    const error = await errorOf(clientWith(fetchFn).sessionCommit('s-1', 'deadbeef'));
    expect(error.kind).toBe('not_found');
  });
});

describe('createApiClient: dispositivos', () => {
  it('devices faz GET em /api/devices e devolve a lista', async () => {
    const devices = [
      { id: 'd-1', name: 'iPhone', createdAt: 1, lastSeenAt: 2, current: true, expired: false },
      { id: 'd-2', name: 'Notebook', createdAt: 1, lastSeenAt: null, current: false, expired: true },
    ];
    const { calls, fetchFn } = fakeFetch(() => json({ devices }));
    expect(await clientWith(fetchFn).devices()).toEqual(devices);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/devices');
  });

  it('revokeDevice faz DELETE no id codificado', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).revokeDevice('d/1');
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/devices/d%2F1');
  });

  it('revokeDevice com id vazio nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    const error = await errorOf(clientWith(fetchFn).revokeDevice(''));
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});

describe('createApiClient: worktree', () => {
  it('createSession envia worktree: true no corpo', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION));
    await clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp', worktree: true });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      workspaceId: 'w-1',
      agent: 'omp',
      worktree: true,
    });
  });

  it('deleteSession sem opção não manda removeWorktree', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteSession('s-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1');
  });

  it('deleteSession com removeWorktree false não manda o parâmetro', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteSession('s-1', { removeWorktree: false });
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1');
  });

  it('deleteSession com removeWorktree true manda ?removeWorktree=1', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteSession('s-1', { removeWorktree: true });
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1?removeWorktree=1');
  });

  it('deleteSession com forget true manda ?forget=1 (remover do app)', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteSession('s-1', { removeWorktree: false, forget: true });
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1?forget=1');
  });

  it('deleteSession com forget e removeWorktree manda os dois parâmetros', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteSession('s-1', { removeWorktree: true, forget: true });
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1?removeWorktree=1&forget=1');
  });

  it('409 worktree_dirty vira worktree_dirty', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'worktree_dirty' }, 409));
    const error = await errorOf(clientWith(fetchFn).deleteSession('s-1', { removeWorktree: true }));
    expect(error.kind).toBe('worktree_dirty');
    expect(error.status).toBe(409);
  });

  it('400 not_git vira not_git', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'not_git' }, 400));
    const error = await errorOf(
      clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp', worktree: true }),
    );
    expect(error.kind).toBe('not_git');
    expect(error.status).toBe(400);
  });

  it('409 no_commits vira no_commits', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'no_commits' }, 409));
    const error = await errorOf(
      clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp', worktree: true }),
    );
    expect(error.kind).toBe('no_commits');
  });

  it('400 sem código conhecido continua invalid_input', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'outra' }, 400));
    const error = await errorOf(clientWith(fetchFn).listWorkspaces());
    expect(error.kind).toBe('invalid_input');
  });
});
