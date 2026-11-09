import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './api.js';

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
  throw new Error('esperava ApiError');
}

const RESULT = {
  sessionId: 's-1',
  workspaceId: 'w-1',
  title: 'Refatorar o parser',
  snippet: 'vou olhar o parser agora',
  matchedAt: 1_700_000_000_000,
};

describe('createApiClient: searchSessions', () => {
  it('sends GET to /api/sessions/search with q encoded, limit 20 by default, and the Bearer token', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ results: [RESULT] }));

    const results = await clientWith(fetchFn).searchSessions({ q: 'sessão' });

    expect(results).toEqual([RESULT]);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/sessions/search');
    expect(url.searchParams.get('q')).toBe('sessão');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.has('workspaceId')).toBe(false);
    expect(calls[0]?.init?.headers).toEqual({ authorization: 'Bearer tok-1' });
  });

  it('sends limit and workspaceId when the screen asks for them', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ results: [] }));

    await clientWith(fetchFn).searchSessions({ q: 'parser', limit: 5, workspaceId: 'w-1' });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('workspaceId')).toBe('w-1');
  });

  it('does not touch the network for a search outside the limits: invalid_input', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ results: [] }));
    const client = clientWith(fetchFn);

    expect((await errorOf(client.searchSessions({ q: 'a' }))).kind).toBe('invalid_input');
    expect((await errorOf(client.searchSessions({ q: 'ab', limit: 51 }))).kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('a daemon error becomes a typed ApiError; a response in the wrong shape becomes unexpected', async () => {
    const badRequest = clientWith(fakeFetch(() => json({ error: 'invalid_request' }, 400)).fetchFn);
    expect((await errorOf(badRequest.searchSessions({ q: 'ab' }))).kind).toBe('invalid_input');

    const malformed = clientWith(fakeFetch(() => json({ results: [{ sessionId: 's-1' }] })).fetchFn);
    expect((await errorOf(malformed.searchSessions({ q: 'ab' }))).kind).toBe('unexpected');
  });
});
