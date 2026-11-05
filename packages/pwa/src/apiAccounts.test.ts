import type { AccountLoginState, AgentProfile } from '@nanachi/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadAgentAccounts, resetAgentAccountsCache } from './agentAccountsCache.js';
import { ApiError, createApiClient, type FetchLike } from './api.js';

const PROFILE: AgentProfile = {
  id: 'a-1',
  label: 'Trabalho',
  isDefault: false,
  active: false,
  status: 'logged_out',
  account: null,
  detail: null,
  checkedAt: 1_700_000_000_000,
};

const LOGIN: AccountLoginState = {
  accountId: 'a-1',
  state: 'waiting',
  url: 'https://claude.com/cai/oauth/authorize?code=true',
  userCode: null,
  needsCode: true,
  codeSent: false,
  output: '',
  error: null,
  account: null,
};

const SESSION = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'claude',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'idle',
  accountId: 'a-1',
  worktree: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchFn };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
  throw new Error('esperava um erro');
}

const bodyOf = (call: Call | undefined): unknown => JSON.parse(String(call?.init?.body));
const authOf = (call: Call | undefined): string | null => new Headers(call?.init?.headers).get('authorization');

describe('api: contas extras de um agente', () => {
  it('createAgentAccount faz POST com o nome recortado e devolve o perfil (201)', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(PROFILE, 201));
    expect(await clientWith(fetchFn).createAgentAccount('claude', '  Trabalho  ')).toEqual(PROFILE);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/claude/accounts');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(authOf(calls[0])).toBe('Bearer tok-1');
    expect(bodyOf(calls[0])).toEqual({ label: 'Trabalho' });
  });

  it('createAgentAccount recusa nome vazio ou com mais de 40 caracteres sem tocar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(PROFILE, 201));
    const client = clientWith(fetchFn);
    expect((await errorOf(client.createAgentAccount('claude', '   '))).kind).toBe('invalid_input');
    expect((await errorOf(client.createAgentAccount('claude', 'x'.repeat(41)))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('createAgentAccount 409 too_many_accounts mantém o código (kind segue unexpected)', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'too_many_accounts' }, 409));
    const error = await errorOf(clientWith(fetchFn).createAgentAccount('claude', 'Casa'));
    expect(error.code).toBe('too_many_accounts');
    expect(error.status).toBe(409);
    expect(error.kind).toBe('unexpected');
  });

  it('createAgentAccount 400 accounts_unsupported vira invalid_input com o código', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'accounts_unsupported' }, 400));
    const error = await errorOf(clientWith(fetchFn).createAgentAccount('omp', 'Casa'));
    expect(error.kind).toBe('invalid_input');
    expect(error.code).toBe('accounts_unsupported');
  });

  it('resposta de perfil fora do schema vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ id: 'a-1' }, 201));
    expect((await errorOf(clientWith(fetchFn).createAgentAccount('claude', 'Casa'))).kind).toBe('unexpected');
  });

  it('renameAgentAccount faz PATCH em /api/agents/:agent/accounts/:id com o nome recortado', async () => {
    const renamed = { ...PROFILE, label: 'Casa' };
    const { calls, fetchFn } = fakeFetch(() => json(renamed));
    expect(await clientWith(fetchFn).renameAgentAccount('claude', 'a-1', ' Casa ')).toEqual(renamed);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/claude/accounts/a-1');
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(bodyOf(calls[0])).toEqual({ label: 'Casa' });
  });

  it('renameAgentAccount recusa nome vazio sem tocar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(PROFILE));
    expect((await errorOf(clientWith(fetchFn).renameAgentAccount('claude', 'a-1', ''))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('deleteAgentAccount faz DELETE e aceita 204', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteAgentAccount('claude', 'a-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/claude/accounts/a-1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('deleteAgentAccount 409 account_in_use mantém o código', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'account_in_use' }, 409));
    const error = await errorOf(clientWith(fetchFn).deleteAgentAccount('claude', 'a-1'));
    expect(error.code).toBe('account_in_use');
    expect(error.status).toBe(409);
  });

  it('setActiveAgentAccount faz PUT em accounts/active e devolve o id gravado', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ accountId: 'a-1' }));
    expect(await clientWith(fetchFn).setActiveAgentAccount('claude', 'a-1')).toBe('a-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/claude/accounts/active');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(bodyOf(calls[0])).toEqual({ accountId: 'a-1' });
  });

  it('setActiveAgentAccount aceita "default" (conta principal)', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ accountId: 'default' }));
    expect(await clientWith(fetchFn).setActiveAgentAccount('claude', 'default')).toBe('default');
    expect(bodyOf(calls[0])).toEqual({ accountId: 'default' });
  });

  it('protege agente e conta no caminho e recusa id vazio sem tocar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(PROFILE));
    const client = clientWith(fetchFn);
    await client.renameAgentAccount('a b', 'x/y', 'Casa');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/a%20b/accounts/x%2Fy');
    expect((await errorOf(client.deleteAgentAccount('', 'a-1'))).kind).toBe('invalid_input');
    expect((await errorOf(client.setActiveAgentAccount('claude', ''))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(1);
  });
});

describe('api: login de uma conta', () => {
  it('startAccountLogin faz POST em .../login e valida o estado', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(LOGIN));
    expect(await clientWith(fetchFn).startAccountLogin('claude', 'a-1')).toEqual(LOGIN);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/claude/accounts/a-1/login');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(authOf(calls[0])).toBe('Bearer tok-1');
  });

  it('startAccountLogin 409 login_in_progress mantém o código', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'login_in_progress' }, 409));
    const error = await errorOf(clientWith(fetchFn).startAccountLogin('claude', 'a-1'));
    expect(error.code).toBe('login_in_progress');
  });

  it('fetchAccountLogin faz GET em .../login', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ ...LOGIN, state: 'succeeded', account: 'pessoa@exemplo.com' }));
    const state = await clientWith(fetchFn).fetchAccountLogin('claude', 'default');
    expect(state.state).toBe('succeeded');
    expect(state.account).toBe('pessoa@exemplo.com');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/claude/accounts/default/login');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('fetchAccountLogin 404 vira not_found', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'not_found' }, 404));
    expect((await errorOf(clientWith(fetchFn).fetchAccountLogin('claude', 'a-1'))).kind).toBe('not_found');
  });

  it('estado de login com state desconhecido vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ ...LOGIN, state: 'quase' }));
    expect((await errorOf(clientWith(fetchFn).fetchAccountLogin('claude', 'a-1'))).kind).toBe('unexpected');
  });

  it('cancelAccountLogin faz DELETE em .../login e aceita 204', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).cancelAccountLogin('claude', 'a-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/claude/accounts/a-1/login');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('sendAccountLoginCode recorta o código antes de enviar', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ ...LOGIN, codeSent: true }));
    const state = await clientWith(fetchFn).sendAccountLoginCode('claude', 'a-1', '  abc#123 \n');
    expect(state.codeSent).toBe(true);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/agents/claude/accounts/a-1/login/code');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({ code: 'abc#123' });
  });

  it('sendAccountLoginCode recusa código vazio, só espaços ou com caractere de controle sem tocar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(LOGIN));
    const client = clientWith(fetchFn);
    expect((await errorOf(client.sendAccountLoginCode('claude', 'a-1', '   '))).kind).toBe('invalid_input');
    expect((await errorOf(client.sendAccountLoginCode('claude', 'a-1', 'ab\u0007cd'))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('sendAccountLoginCode 409 invalid_state mantém o código', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'invalid_state' }, 409));
    const error = await errorOf(clientWith(fetchFn).sendAccountLoginCode('claude', 'a-1', 'abc'));
    expect(error.code).toBe('invalid_state');
  });
});

describe('api: conta de uma sessão', () => {
  it('setSessionAccount faz PUT em /api/sessions/:id/account e devolve a sessão', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION));
    const session = await clientWith(fetchFn).setSessionAccount('s-1', 'a-1');
    expect(session.accountId).toBe('a-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/account');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(bodyOf(calls[0])).toEqual({ accountId: 'a-1' });
  });

  it('setSessionAccount aceita "default" e sessão sem accountId na resposta (daemon antigo)', async () => {
    const { accountId: _omitted, ...legacy } = SESSION;
    const { calls, fetchFn } = fakeFetch(() => json(legacy));
    const session = await clientWith(fetchFn).setSessionAccount('s-1', 'default');
    expect(session.accountId).toBeNull();
    expect(bodyOf(calls[0])).toEqual({ accountId: 'default' });
  });

  it('setSessionAccount: 409 session_busy, 409 not_resumable e 400 accounts_unsupported mantêm o código', async () => {
    const busy = await errorOf(clientWith(fakeFetch(() => json({ error: 'session_busy' }, 409)).fetchFn).setSessionAccount('s-1', 'a-1'));
    expect(busy.code).toBe('session_busy');
    expect(busy.status).toBe(409);

    const resumable = await errorOf(
      clientWith(fakeFetch(() => json({ error: 'not_resumable' }, 409)).fetchFn).setSessionAccount('s-1', 'a-1'),
    );
    expect(resumable.kind).toBe('not_resumable');
    expect(resumable.code).toBe('not_resumable');

    const unsupported = await errorOf(
      clientWith(fakeFetch(() => json({ error: 'accounts_unsupported' }, 400)).fetchFn).setSessionAccount('s-1', 'a-1'),
    );
    expect(unsupported.code).toBe('accounts_unsupported');
  });

  it('setSessionAccount recusa id vazio sem tocar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION));
    const client = clientWith(fetchFn);
    expect((await errorOf(client.setSessionAccount('s-1', ''))).kind).toBe('invalid_input');
    expect((await errorOf(client.setSessionAccount('', 'a-1'))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});

describe('api: criação de sessão com conta', () => {
  it('createSession envia accountId quando dado', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION));
    await clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'claude', accountId: 'a-1' });
    expect(bodyOf(calls[0])).toMatchObject({ workspaceId: 'w-1', agent: 'claude', accountId: 'a-1' });
  });

  it('createSession sem accountId não manda o campo', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION));
    await clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'claude' });
    expect(bodyOf(calls[0])).not.toHaveProperty('accountId');
  });
});

describe('api: lista de contas com perfis', () => {
  const ENTRY = {
    agentId: 'claude',
    label: 'Claude Code',
    status: 'logged_in',
    account: 'pessoa@exemplo.com',
    detail: null,
    checkedAt: 1_700_000_000_000,
  };

  it('aceita resposta de daemon antigo, sem supportsAccounts e profiles', async () => {
    const { fetchFn } = fakeFetch(() => json({ accounts: [ENTRY] }));
    const [account] = await clientWith(fetchFn).agentAccounts(false);
    expect(account?.supportsAccounts).toBe(false);
    expect(account?.profiles).toEqual([]);
  });

  it('devolve os perfis quando o agente tem contas', async () => {
    const principal: AgentProfile = {
      id: 'default',
      label: 'Principal',
      isDefault: true,
      active: true,
      status: 'logged_in',
      account: 'pessoa@exemplo.com',
      detail: null,
      checkedAt: 1_700_000_000_000,
    };
    const { fetchFn } = fakeFetch(() => json({ accounts: [{ ...ENTRY, supportsAccounts: true, profiles: [principal, PROFILE] }] }));
    const [account] = await clientWith(fetchFn).agentAccounts(false);
    expect(account?.supportsAccounts).toBe(true);
    expect(account?.profiles.map((profile) => profile.id)).toEqual(['default', 'a-1']);
  });
});

describe('api: a mudança de contas derruba a lista guardada (agentAccountsCache)', () => {
  const ENTRY = {
    agentId: 'claude',
    label: 'Claude Code',
    status: 'logged_in',
    account: null,
    detail: null,
    checkedAt: 1_700_000_000_000,
    supportsAccounts: true,
    profiles: [],
  };

  beforeEach(() => resetAgentAccountsCache());

  /** A fake daemon: the list answers `GET /api/agents/accounts`, the other routes answer `answer`. */
  function daemon(answer: (call: Call) => Response) {
    return fakeFetch((call) => (call.url.endsWith('/api/agents/accounts') ? json({ accounts: [ENTRY] }) : answer(call)));
  }
  const listReads = (calls: Call[]) => calls.filter((call) => call.url.endsWith('/api/agents/accounts')).length;

  /** Loads the list twice (one read), runs `change`, loads again, and says whether it was read again. */
  async function dropsTheList(change: (client: ReturnType<typeof clientWith>) => Promise<unknown>, answer: (call: Call) => Response) {
    resetAgentAccountsCache();
    const { calls, fetchFn } = daemon(answer);
    const client = clientWith(fetchFn);
    await loadAgentAccounts(client);
    await loadAgentAccounts(client);
    expect(listReads(calls)).toBe(1);
    await change(client).catch(() => undefined);
    await loadAgentAccounts(client);
    return listReads(calls) === 2;
  }

  it('criar, renomear, remover e "usar em novas sessões" derrubam a lista', async () => {
    expect(await dropsTheList((client) => client.createAgentAccount('claude', 'Casa'), () => json(PROFILE, 201))).toBe(true);
    expect(await dropsTheList((client) => client.renameAgentAccount('claude', 'a-1', 'Casa 2'), () => json(PROFILE))).toBe(true);
    expect(await dropsTheList((client) => client.deleteAgentAccount('claude', 'a-1'), () => new Response(null, { status: 204 }))).toBe(true);
    expect(await dropsTheList((client) => client.setActiveAgentAccount('claude', 'a-1'), () => json({ accountId: 'a-1' }))).toBe(true);
  });

  it('uma mudança que falhou também derruba a lista (o PC pode ter feito antes de falhar)', async () => {
    expect(await dropsTheList((client) => client.createAgentAccount('claude', 'Casa'), () => json({ error: 'too_many_accounts' }, 409))).toBe(true);
    expect(await dropsTheList((client) => client.deleteAgentAccount('claude', 'a-1'), () => json({ error: 'account_in_use' }, 409))).toBe(true);
  });

  it('um pedido recusado antes de sair (nome inválido) não derruba nada', async () => {
    expect(await dropsTheList((client) => client.createAgentAccount('claude', '   '), () => json(PROFILE, 201))).toBe(false);
  });

  it('login que terminou com sucesso derruba a lista, em qualquer das três respostas', async () => {
    const done = { ...LOGIN, state: 'succeeded', account: 'pessoa@exemplo.com' };
    expect(await dropsTheList((client) => client.startAccountLogin('claude', 'a-1'), () => json(done))).toBe(true);
    expect(await dropsTheList((client) => client.fetchAccountLogin('claude', 'a-1'), () => json(done))).toBe(true);
    expect(await dropsTheList((client) => client.sendAccountLoginCode('claude', 'a-1', 'abc'), () => json(done))).toBe(true);
  });

  it('login em andamento, falho ou cancelado, e o cancelamento, não derrubam a lista', async () => {
    for (const state of ['starting', 'waiting', 'verifying', 'failed', 'cancelled']) {
      const login = { ...LOGIN, state };
      expect(await dropsTheList((client) => client.fetchAccountLogin('claude', 'a-1'), () => json(login))).toBe(false);
    }
    expect(await dropsTheList((client) => client.cancelAccountLogin('claude', 'a-1'), () => new Response(null, { status: 204 }))).toBe(false);
  });

  it('trocar a conta de uma sessão não mexe na lista de contas', async () => {
    expect(await dropsTheList((client) => client.setSessionAccount('s-1', 'a-1'), () => json(SESSION))).toBe(false);
  });

  it('só a lista da máquina que mudou cai', async () => {
    const a = daemon(() => json(PROFILE, 201));
    const clientA = createApiClient({ baseUrl: 'http://127.0.0.1:7777/', token: 't' }, a.fetchFn);
    const b = daemon(() => json(PROFILE, 201));
    const clientB = createApiClient({ baseUrl: 'http://127.0.0.1:7778/', token: 't' }, b.fetchFn);
    await loadAgentAccounts(clientA);
    await loadAgentAccounts(clientB);
    await clientA.createAgentAccount('claude', 'Casa');
    await loadAgentAccounts(clientA);
    await loadAgentAccounts(clientB);
    expect(listReads(a.calls)).toBe(2);
    expect(listReads(b.calls)).toBe(1);
  });
});
