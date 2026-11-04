import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './api.js';

const SESSION = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'omp',
  kind: 'acp',
  title: 'Refatorar o parser',
  status: 'idle',
  worktree: null,
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

const LISTING = {
  supported: true,
  sessions: [
    { acpSessionId: 'acp-1', title: 'Refatorar o parser', updatedAt: 1_700_000_000_000, linkedSessionId: null },
    { acpSessionId: 'acp-2', title: null, updatedAt: null, linkedSessionId: 's-9' },
  ],
  nextCursor: 'cur-2',
};

describe('createApiClient: agentSessions', () => {
  it('faz GET em agent-sessions com o agente e devolve a página validada', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(LISTING));
    const page = await clientWith(fetchFn).agentSessions('w-1', 'omp');

    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/workspaces/w-1/agent-sessions?agent=omp');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(page).toEqual(LISTING);
  });

  it('manda o cursor da página seguinte', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ ...LISTING, nextCursor: null }));
    await clientWith(fetchFn).agentSessions('w-1', 'omp', 'cur 2');

    expect(calls[0]?.url).toBe(
      'http://127.0.0.1:7777/api/workspaces/w-1/agent-sessions?agent=omp&cursor=cur+2',
    );
  });

  it('agente que não lista sessões: supported false, sem sessões', async () => {
    const { fetchFn } = fakeFetch(() => json({ supported: false, sessions: [], nextCursor: null }));
    const page = await clientWith(fetchFn).agentSessions('w-1', 'agy');
    expect(page).toEqual({ supported: false, sessions: [], nextCursor: null });
  });

  it('resposta fora do schema vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ sessions: [] }));
    const error = await errorOf(clientWith(fetchFn).agentSessions('w-1', 'omp'));
    expect(error.kind).toBe('unexpected');
  });

  it('id de workspace vazio nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(LISTING));
    const error = await errorOf(clientWith(fetchFn).agentSessions('', 'omp'));
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('429 busy vira busy (já há listagem em andamento)', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'busy' }, 429));
    const error = await errorOf(clientWith(fetchFn).agentSessions('w-1', 'omp'));
    expect(error.kind).toBe('busy');
    expect(error.status).toBe(429);
  });

  it('504 agent_timeout vira agent_timeout', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'agent_timeout' }, 504));
    const error = await errorOf(clientWith(fetchFn).agentSessions('w-1', 'omp'));
    expect(error.kind).toBe('agent_timeout');
  });

  it('502 agent_failed vira agent_failed', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'agent_failed' }, 502));
    const error = await errorOf(clientWith(fetchFn).agentSessions('w-1', 'omp'));
    expect(error.kind).toBe('agent_failed');
  });
});

describe('createApiClient: importar sessão do PC (createSession com resume)', () => {
  it('manda resumeAcpSessionId e resumeTitle no corpo', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION, 201));
    await clientWith(fetchFn).createSession({
      workspaceId: 'w-1',
      agent: 'omp',
      resumeAcpSessionId: 'acp-1',
      resumeTitle: 'Refatorar o parser',
    });

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      workspaceId: 'w-1',
      agent: 'omp',
      resumeAcpSessionId: 'acp-1',
      resumeTitle: 'Refatorar o parser',
    });
  });

  it('resumeAcpSessionId vazio é invalid_input e nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(SESSION, 201));
    const error = await errorOf(
      clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp', resumeAcpSessionId: '' }),
    );
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('409 already_running carrega o sessionId da sessão aberta', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'already_running', sessionId: 's-7' }, 409));
    const error = await errorOf(
      clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp', resumeAcpSessionId: 'acp-1' }),
    );
    expect(error.kind).toBe('already_running');
    expect(error.sessionId).toBe('s-7');
  });

  it('409 already_linked carrega o sessionId da sessão parada', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'already_linked', sessionId: 's-8' }, 409));
    const error = await errorOf(
      clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp', resumeAcpSessionId: 'acp-1' }),
    );
    expect(error.kind).toBe('already_linked');
    expect(error.sessionId).toBe('s-8');
  });

  it('erro sem sessionId deixa o campo null', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'not_resumable' }, 409));
    const error = await errorOf(
      clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp', resumeAcpSessionId: 'acp-1' }),
    );
    expect(error.kind).toBe('not_resumable');
    expect(error.sessionId).toBeNull();
  });

  it('409 sem código conhecido continua unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'session_busy' }, 409));
    const error = await errorOf(
      clientWith(fetchFn).createSession({ workspaceId: 'w-1', agent: 'omp', resumeAcpSessionId: 'acp-1' }),
    );
    expect(error.kind).toBe('unexpected');
  });
});
