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
  accountId: null,
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

  it('sessionConfigOptions faz GET em /api/sessions/:id/config e devolve a lista', async () => {
    const configOptions = [{ id: 'mode', name: 'Acesso', type: 'boolean', currentValue: true }];
    const { calls, fetchFn } = fakeFetch(() => json({ configOptions }));
    expect(await clientWith(fetchFn).sessionConfigOptions('s-1')).toEqual(configOptions);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/config');
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
      supportsAccounts: false,
      profiles: [],
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

describe('createApiClient: uso do agente', () => {
  const USAGE = { agent: 'omp', text: '5 hours: 20% used', fetchedAt: 1_700_000_000_000 };

  it('fetchSessionUsage faz POST em /api/sessions/:id/usage com Bearer e devolve o texto', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(USAGE));
    expect(await clientWith(fetchFn).fetchSessionUsage('s-1')).toEqual(USAGE);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/usage');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok-1');
  });

  it('409 session_not_active mantém o status e o código do corpo', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'session_not_active' }, 409));
    const error = await errorOf(clientWith(fetchFn).fetchSessionUsage('s-1'));
    expect(error.status).toBe(409);
    expect(error.code).toBe('session_not_active');
  });

  it('409 session_busy tem o código, e o kind segue unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'session_busy' }, 409));
    const error = await errorOf(clientWith(fetchFn).fetchSessionUsage('s-1'));
    expect(error.kind).toBe('unexpected');
    expect(error.code).toBe('session_busy');
  });

  it('400 usage_unsupported vira invalid_input com o código', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'usage_unsupported' }, 400));
    const error = await errorOf(clientWith(fetchFn).fetchSessionUsage('s-1'));
    expect(error.kind).toBe('invalid_input');
    expect(error.status).toBe(400);
    expect(error.code).toBe('usage_unsupported');
  });

  it('504 agent_timeout vira agent_timeout', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'agent_timeout' }, 504));
    const error = await errorOf(clientWith(fetchFn).fetchSessionUsage('s-1'));
    expect(error.kind).toBe('agent_timeout');
    expect(error.status).toBe(504);
  });

  it('resposta fora do schema vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ agent: 'omp', text: 1 }));
    expect((await errorOf(clientWith(fetchFn).fetchSessionUsage('s-1'))).kind).toBe('unexpected');
  });
});

describe('createApiClient: resets salvos', () => {
  const RESETS = {
    agent: 'omp',
    entries: [
      {
        target: 'anthropic/1',
        accountLabel: 'fake@example.com',
        providerLabel: 'Anthropic',
        available: 2,
        usable: 1,
        expiresAt: 'in 3 days',
        note: null,
        active: true,
      },
    ],
    message: null,
    fetchedAt: 1_700_000_000_000,
  };
  const REDEEMED = { outcome: 'reset', message: 'Reset applied for fake@example.com (Anthropic).' };

  it('getUsageResets faz GET em /api/sessions/:id/usage/resets com Bearer e devolve as linhas', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(RESETS));
    expect(await clientWith(fetchFn).getUsageResets('s-1')).toEqual(RESETS);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/usage/resets');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok-1');
  });

  it('getUsageResets aceita a lista vazia com a mensagem do agente e o selo de cache', async () => {
    const body = { agent: 'omp', entries: [], message: 'No provider accounts found.', fetchedAt: 5, cached: true };
    const { fetchFn } = fakeFetch(() => json(body));
    expect(await clientWith(fetchFn).getUsageResets('s-1')).toEqual(body);
  });

  it('getUsageResets: 400 resets_unsupported mantém o código', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'resets_unsupported' }, 400));
    const error = await errorOf(clientWith(fetchFn).getUsageResets('s-1'));
    expect(error.kind).toBe('invalid_input');
    expect(error.status).toBe(400);
    expect(error.code).toBe('resets_unsupported');
  });

  it('getUsageResets: 502 agent_failed e 504 agent_timeout viram o tipo próprio', async () => {
    const failed = fakeFetch(() => json({ error: 'agent_failed' }, 502));
    expect((await errorOf(clientWith(failed.fetchFn).getUsageResets('s-1'))).kind).toBe('agent_failed');
    const timeout = fakeFetch(() => json({ error: 'agent_timeout' }, 504));
    expect((await errorOf(clientWith(timeout.fetchFn).getUsageResets('s-1'))).kind).toBe('agent_timeout');
  });

  it('getUsageResets: resposta fora do schema vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ agent: 'omp', entries: [{ target: 'x' }], message: null, fetchedAt: 1 }));
    expect((await errorOf(clientWith(fetchFn).getUsageResets('s-1'))).kind).toBe('unexpected');
  });

  it('getUsageResets protege o id no caminho', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(RESETS));
    await clientWith(fetchFn).getUsageResets('a/b');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/a%2Fb/usage/resets');
  });

  it('redeemUsageReset faz POST com o alvo no corpo e devolve o resultado', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(REDEEMED));
    expect(await clientWith(fetchFn).redeemUsageReset('s-1', 'anthropic/1')).toEqual(REDEEMED);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/usage/resets');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok-1');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ target: 'anthropic/1' });
  });

  it('redeemUsageReset: alvo vazio ou longo demais é recusado sem tocar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(REDEEMED));
    expect((await errorOf(clientWith(fetchFn).redeemUsageReset('s-1', ''))).kind).toBe('invalid_input');
    expect((await errorOf(clientWith(fetchFn).redeemUsageReset('s-1', 'x'.repeat(201)))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('redeemUsageReset: 409 reset_in_progress tem o código e o kind segue unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'reset_in_progress' }, 409));
    const error = await errorOf(clientWith(fetchFn).redeemUsageReset('s-1', 'anthropic/1'));
    expect(error.kind).toBe('unexpected');
    expect(error.status).toBe(409);
    expect(error.code).toBe('reset_in_progress');
  });

  it('redeemUsageReset: 400 invalid_request mantém o código', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'invalid_request' }, 400));
    const error = await errorOf(clientWith(fetchFn).redeemUsageReset('s-1', 'anthropic/1'));
    expect(error.kind).toBe('invalid_input');
    expect(error.code).toBe('invalid_request');
  });

  it('redeemUsageReset: 504 agent_timeout e 502 agent_failed mantêm o status', async () => {
    const timeout = fakeFetch(() => json({ error: 'agent_timeout' }, 504));
    const slow = await errorOf(clientWith(timeout.fetchFn).redeemUsageReset('s-1', 'anthropic/1'));
    expect(slow.kind).toBe('agent_timeout');
    expect(slow.status).toBe(504);
    const failed = fakeFetch(() => json({ error: 'agent_failed' }, 502));
    const broken = await errorOf(clientWith(failed.fetchFn).redeemUsageReset('s-1', 'anthropic/1'));
    expect(broken.kind).toBe('agent_failed');
  });

  it('redeemUsageReset: resultado com outcome desconhecido vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ outcome: 'maybe', message: 'x' }));
    expect((await errorOf(clientWith(fetchFn).redeemUsageReset('s-1', 'anthropic/1'))).kind).toBe('unexpected');
  });

  it('redeemUsageReset nunca repete o pedido sozinho', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ error: 'agent_timeout' }, 504));
    await errorOf(clientWith(fetchFn).redeemUsageReset('s-1', 'anthropic/1'));
    expect(calls).toHaveLength(1);
  });
});
