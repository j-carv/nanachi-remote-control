import { describe, expect, it } from 'vitest';
import { ApiError, fetchHealth, pair, type FetchLike } from './api.js';

const PAIR_OK = {
  token: 'tok-123',
  deviceId: 'dev-1',
  machineId: 'm-1',
  machineName: 'DESKTOP-X',
};

const HEALTH_OK = { ok: true, machineId: 'm-1', machineName: 'DESKTOP-X', version: '0.0.0' };

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(respond: () => Response | Promise<Response>) {
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

async function errorOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('esperava ApiError');
}

describe('pair', () => {
  it('faz POST em {baseUrl}/api/pair com código e nome do dispositivo', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(PAIR_OK));
    await pair({ baseUrl: 'https://pc.ts.net/', code: '123456', deviceName: 'iPhone' }, fetchFn);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://pc.ts.net/api/pair');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      code: '123456',
      deviceName: 'iPhone',
    });
  });

  it('retorna a resposta validada pelo schema do shared', async () => {
    const { fetchFn } = fakeFetch(() => json(PAIR_OK));
    const result = await pair(
      { baseUrl: 'http://127.0.0.1:7777', code: '123456', deviceName: 'iPhone' },
      fetchFn,
    );
    expect(result).toEqual(PAIR_OK);
  });

  it('código com formato inválido nem chama a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(PAIR_OK));
    const error = await errorOf(
      pair({ baseUrl: 'http://h:1', code: '12a', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('baseUrl que não é http(s) é recusado sem chamar a rede', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(PAIR_OK));
    const error = await errorOf(
      pair({ baseUrl: 'ftp://h', code: '123456', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('401 vira invalid_code', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'x' }, 401));
    const error = await errorOf(
      pair({ baseUrl: 'http://h:1', code: '123456', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('invalid_code');
    expect(error.status).toBe(401);
  });

  it('429 vira rate_limited', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'x' }, 429));
    const error = await errorOf(
      pair({ baseUrl: 'http://h:1', code: '123456', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('rate_limited');
  });

  it('403 (checagem Tailscale) vira forbidden', async () => {
    const { fetchFn } = fakeFetch(() => json({ error: 'x' }, 403));
    const error = await errorOf(
      pair({ baseUrl: 'http://h:1', code: '123456', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('forbidden');
  });

  it('falha de rede (fetch rejeita) vira network', async () => {
    const fetchFn: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = await errorOf(
      pair({ baseUrl: 'http://h:1', code: '123456', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('network');
  });

  it('500 vira unexpected com o status', async () => {
    const { fetchFn } = fakeFetch(() => json({}, 500));
    const error = await errorOf(
      pair({ baseUrl: 'http://h:1', code: '123456', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('unexpected');
    expect(error.status).toBe(500);
  });

  it('200 com corpo fora do schema vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ token: '' }));
    const error = await errorOf(
      pair({ baseUrl: 'http://h:1', code: '123456', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('unexpected');
  });

  it('200 com corpo que não é JSON vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<html>', { status: 200 }));
    const error = await errorOf(
      pair({ baseUrl: 'http://h:1', code: '123456', deviceName: 'iPhone' }, fetchFn),
    );
    expect(error.kind).toBe('unexpected');
  });
});

describe('fetchHealth', () => {
  it('faz GET em {baseUrl}/api/health e valida a resposta', async () => {
    const { calls, fetchFn } = fakeFetch(() => json(HEALTH_OK));
    const result = await fetchHealth('http://127.0.0.1:7777/', fetchFn);
    expect(calls[0]?.url).toBe('http://127.0.0.1:7777/api/health');
    expect(result).toEqual(HEALTH_OK);
  });

  it('ok diferente de true vira unexpected', async () => {
    const { fetchFn } = fakeFetch(() => json({ ...HEALTH_OK, ok: false }));
    const error = await errorOf(fetchHealth('http://h:1', fetchFn));
    expect(error.kind).toBe('unexpected');
  });

  it('falha de rede vira network', async () => {
    const fetchFn: FetchLike = () => Promise.reject(new TypeError('offline'));
    const error = await errorOf(fetchHealth('http://h:1', fetchFn));
    expect(error.kind).toBe('network');
  });
});
