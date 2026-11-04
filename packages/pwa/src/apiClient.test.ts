import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './api.js';

const WORKSPACE = {
  id: 'w-1',
  name: 'app',
  path: 'C:\\projetos\\app',
  createdAt: 1_700_000_000_000,
  muted: false,
};

const SESSION = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'omp',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'idle',
  configOptions: [],
  worktree: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const EVENT = {
  seq: 3,
  sessionId: 's-1',
  ts: 1_700_000_000_000,
  kind: 'user_message',
  text: 'oi',
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

describe('createApiClient: autenticação', () => {
  it('envia Authorization: Bearer em toda chamada', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ agents: [] }));
    await clientWith(fetchFn).fetchAgents();
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-1');
  });

  it('normaliza a baseUrl (barra final some)', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ agents: [] }));
    await clientWith(fetchFn).fetchAgents();
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents');
  });

  it('baseUrl inválida lança invalid_input na criação', () => {
    expect(() =>
      createApiClient({ baseUrl: 'ftp://pc', token: 't' }, () => Promise.resolve(json({}))),
    ).toThrow(ApiError);
  });
});

describe('createApiClient: pastas e agentes', () => {
  it('fetchRoots faz GET /api/roots e valida', async () => {
    const roots = [{ path: 'C:\\projetos', name: 'projetos' }];
    const { calls, fetchFn } = fakeFetch(() => json({ roots }));
    expect(await clientWith(fetchFn).fetchRoots()).toEqual(roots);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/roots');
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');
  });

  it('fetchFs codifica o caminho na query', async () => {
    const body = { path: 'C:\\projetos\\a b', parent: 'C:\\projetos', dirs: [] };
    const { calls, fetchFn } = fakeFetch(() => json(body));
    expect(await clientWith(fetchFn).fetchFs('C:\\projetos\\a b')).toEqual(body);
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:7777/api/fs?path=C%3A%5Cprojetos%5Ca+b',
    );
  });

  it('fetchFs aceita parent null (raiz permitida)', async () => {
    const body = { path: 'C:\\projetos', parent: null, dirs: [] };
    const { fetchFn } = fakeFetch(() => json(body));
    expect(await clientWith(fetchFn).fetchFs('C:\\projetos')).toEqual(body);
  });

  it('fetchAgents valida a lista de agentes', async () => {
    const agents = [{ id: 'omp', label: 'Oh My Pi', kind: 'acp' }];
    const { fetchFn } = fakeFetch(() => json({ agents }));
    expect(await clientWith(fetchFn).fetchAgents()).toEqual(agents);
  });
});

describe('createApiClient: workspaces', () => {
  it('listWorkspaces devolve os workspaces validados', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ workspaces: [WORKSPACE] }));
    expect(await clientWith(fetchFn).listWorkspaces()).toEqual([WORKSPACE]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/workspaces');
  });

  it('createWorkspace faz POST com path e devolve o workspace', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(WORKSPACE));
    const created = await clientWith(fetchFn).createWorkspace({ path: 'C:\\projetos\\app' });
    expect(created).toEqual(WORKSPACE);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ path: 'C:\\projetos\\app' });
  });

  it('createWorkspace recusa path vazio sem chamar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(WORKSPACE));
    const error = await errorOf(clientWith(fetchFn).createWorkspace({ path: '' }));
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('deleteWorkspace faz DELETE no id codificado e aceita corpo vazio', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteWorkspace('w/1');
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/workspaces/w%2F1');
  });
});

describe('createApiClient: sessões e eventos', () => {
  it('listSessions faz GET /api/workspaces/:id/sessions', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ sessions: [SESSION] }));
    expect(await clientWith(fetchFn).listSessions('w-1')).toEqual([SESSION]);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/workspaces/w-1/sessions');
  });

  it('createSession envia config junto e devolve a sessão', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION));
    const config = { model: 'opus', fast: true };
    const created = await clientWith(fetchFn).createSession({
      workspaceId: 'w-1',
      agent: 'omp',
      config,
    });
    expect(created).toEqual(SESSION);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      workspaceId: 'w-1',
      agent: 'omp',
      config,
    });
  });

  it('createSession sem config não manda a chave config', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION));
    await clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ workspaceId: 'w-1', agent: 'omp' });
  });

  it('createSession recusa agente vazio sem chamar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION));
    const error = await errorOf(clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: '' }));
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('resumeSession faz POST em /api/sessions/:id/resume e devolve a sessão', async () => {
    const resumed = { ...SESSION, status: 'idle' };
    const { calls, fetchFn } = fakeFetch(() => json(resumed));
    expect(await clientWith(fetchFn).resumeSession('s-1')).toEqual(resumed);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/resume');
  });

  it('resumeSession 409 not_resumable vira not_resumable', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'not_resumable' }, 409));
    const error = await errorOf(clientWith(fetchFn).resumeSession('s-1'));
    expect(error.kind).toBe('not_resumable');
    expect(error.status).toBe(409);
  });

  it('resumeSession 409 already_running vira already_running', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'already_running' }, 409));
    const error = await errorOf(clientWith(fetchFn).resumeSession('s-1'));
    expect(error.kind).toBe('already_running');
  });

  it('409 sem código conhecido vira unexpected com o status', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'outra_coisa' }, 409));
    const error = await errorOf(clientWith(fetchFn).resumeSession('s-1'));
    expect(error.kind).toBe('unexpected');
    expect(error.status).toBe(409);
  });

  it('createSession 429 too_many_sessions vira too_many_sessions', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'too_many_sessions' }, 429));
    const error = await errorOf(clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp' }));
    expect(error.kind).toBe('too_many_sessions');
    expect(error.status).toBe(429);
  });

  it('deleteSession faz DELETE em /api/sessions/:id', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteSession('s-1');
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1');
  });

  it('fetchEvents manda after e limit na query e valida a lista', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ events: [EVENT] }));
    expect(await clientWith(fetchFn).fetchEvents('s-1', { after: 2, limit: 100 })).toEqual([
      EVENT,
    ]);
    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:7777/api/sessions/s-1/events?after=2&limit=100',
    );
  });

  it('sessionCommands faz GET em /api/sessions/:id/commands e devolve a lista', async () => {
    const commands = [{ name: 'loop', description: 'Repete', hint: '[intervalo] [prompt]' }];
    const { calls, fetchFn } = fakeFetch(() => json({ commands }));
    expect(await clientWith(fetchFn).sessionCommands('s-1')).toEqual(commands);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/commands');
  });

  it('fetchEvents com limit acima de 500 nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ events: [] }));
    const error = await errorOf(clientWith(fetchFn).fetchEvents('s-1', { after: 0, limit: 501 }));
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('resposta fora do schema vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ sessions: [{ id: 's-1' }] }));
    const error = await errorOf(clientWith(fetchFn).listSessions('w-1'));
    expect(error.kind).toBe('unexpected');
  });
});

describe('createApiClient: erros', () => {
  it.each([
    [401, 'unauthorized'],
    [400, 'invalid_input'],
    [404, 'not_found'],
    [429, 'rate_limited'],
  ] as const)('HTTP %i vira %s', async (status, kind) => {
    const { fetchFn } = fakeFetch(() => json({ error: 'x' }, status));
    const error = await errorOf(clientWith(fetchFn).listWorkspaces());
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
  });

  it('403 com error outside_roots vira outside_roots', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'outside_roots' }, 403));
    const error = await errorOf(clientWith(fetchFn).fetchFs('C:\\fora'));
    expect(error.kind).toBe('outside_roots');
    expect(error.status).toBe(403);
  });

  it('400 com error not_a_directory vira not_a_directory', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'not_a_directory' }, 400));
    const error = await errorOf(clientWith(fetchFn).fetchFs('C:\\arquivo.txt'));
    expect(error.kind).toBe('not_a_directory');
    expect(error.status).toBe(400);
  });

  it('403 sem error conhecido (Tailscale) vira forbidden', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'tailscale_login' }, 403));
    const error = await errorOf(clientWith(fetchFn).listWorkspaces());
    expect(error.kind).toBe('forbidden');
  });

  it('403 com corpo que não é JSON vira forbidden', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<html>', { status: 403 }));
    const error = await errorOf(clientWith(fetchFn).listWorkspaces());
    expect(error.kind).toBe('forbidden');
  });

  it('500 vira unexpected com o status', async () => {
    const { fetchFn } = fakeFetch(() => json({}, 500));
    const error = await errorOf(clientWith(fetchFn).listWorkspaces());
    expect(error.kind).toBe('unexpected');
    expect(error.status).toBe(500);
  });

  it('falha de rede vira network', async () => {
    const fetchFn: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await errorOf(clientWith(fetchFn).listWorkspaces());
    expect(error.kind).toBe('network');
    expect(error.status).toBeNull();
  });

  it('DELETE com 500 também vira erro', async () => {
    const { fetchFn } = fakeFetch(() => json({}, 500));
    const error = await errorOf(clientWith(fetchFn).deleteSession('s-1'));
    expect(error.kind).toBe('unexpected');
  });
});

describe('createApiClient: contas dos agentes', () => {
  const ACCOUNTS = [
    {
      agentId: 'claude',
      label: 'Claude Code',
      status: 'logged_in',
      account: 'pessoa@exemplo.com',
      detail: 'Equipe · team',
      checkedAt: 1_700_000_000_000,
    },
  ];

  it('agentAccounts faz GET /api/agents/accounts sem refresh e valida a lista', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ accounts: ACCOUNTS }));
    expect(await clientWith(fetchFn).agentAccounts(false)).toEqual(ACCOUNTS);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/accounts');
  });

  it('agentAccounts(true) pede refresh=1', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ accounts: ACCOUNTS }));
    await clientWith(fetchFn).agentAccounts(true);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/accounts?refresh=1');
  });

  it('resposta fora do schema vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ accounts: [{ agentId: 'x' }] }));
    expect((await errorOf(clientWith(fetchFn).agentAccounts(false))).kind).toBe('unexpected');
  });
});
