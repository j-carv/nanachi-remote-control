import type { Loop } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient, type FetchLike } from './api.js';
import { describeLoopError } from './errorMessages.js';

const LOOP: Loop = {
  sessionId: 's-1',
  prompt: 'revise os testes',
  mode: 'interval',
  intervalMs: 300_000,
  maxIterations: null,
  iterations: 0,
  state: 'active',
  nextRunAt: null,
  lastRunAt: null,
  lastError: null,
  createdAt: 1_700_000_000_000,
  revision: 1,
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

describe('api: loop da sessão', () => {
  it('GET devolve o loop, ou null quando não há', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ loop: LOOP }));
    expect(await clientWith(fetchFn).fetchLoop('s-1')).toEqual(LOOP);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/loop');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok-1');

    const none = fakeFetch(() => json({ loop: null }));
    expect(await clientWith(none.fetchFn).fetchLoop('s-1')).toBeNull();
  });

  it('PUT manda o pedido validado e devolve o loop criado', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ loop: LOOP }));
    const loop = await clientWith(fetchFn).putLoop('s-1', {
      prompt: 'revise os testes',
      mode: 'interval',
      intervalMs: 300_000,
      runNow: true,
    });
    expect(loop).toEqual(LOOP);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      prompt: 'revise os testes',
      mode: 'interval',
      intervalMs: 300_000,
      runNow: true,
    });
  });

  it('PUT com pedido inválido nem chega à rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ loop: LOOP }));
    const error = await errorOf(
      clientWith(fetchFn).putLoop('s-1', { prompt: 'x', mode: 'interval' } as never),
    );
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('pausar, retomar e rodar agora são POST nas rotas próprias', async () => {
    for (const [action, path] of [
      ['pauseLoop', 'pause'],
      ['resumeLoop', 'resume'],
      ['runLoopNow', 'run-now'],
    ] as const) {
      const { calls, fetchFn } = fakeFetch(() => json({ loop: LOOP }));
      const client = clientWith(fetchFn);
      expect(await client[action]('s-1')).toEqual(LOOP);
      expect(calls[0]?.url).toBe(`http://127.0.0.1:7777/api/sessions/s-1/loop/${path}`);
      expect(calls[0]?.init?.method).toBe('POST');
    }
  });

  it('DELETE para e apaga o loop (204)', async () => {
    const { calls, fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
    await clientWith(fetchFn).deleteLoop('s-1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/sessions/s-1/loop');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('guarda o código do erro do loop (loop_busy, not_acp, loop_finished, loop_not_found)', async () => {
    const cases: Array<[number, string]> = [
      [409, 'loop_busy'],
      [409, 'not_acp'],
      [409, 'loop_finished'],
      [404, 'loop_not_found'],
    ];
    for (const [status, code] of cases) {
      const { fetchFn } = fakeFetch(() => json({ error: code }, status));
      const error = await errorOf(clientWith(fetchFn).pauseLoop('s-1'));
      expect(error.code).toBe(code);
      expect(describeLoopError(error)).not.toBe('Erro inesperado.');
    }
  });
});
