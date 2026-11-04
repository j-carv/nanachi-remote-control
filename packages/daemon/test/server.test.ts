import { PairResponseSchema } from '@nanachi/shared';
import type { HealthResponse, MeResponse, PairResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { createPairCode, PAIR_CODE_TTL_MS } from '../src/pairing.js';
import { serializeRequest } from '../src/log.js';
import { revokeDevice } from '../src/repository.js';
import { differentCode, issueCode, setupDaemonTests, TEST_VERSION, type TestDaemon } from './support.js';

const env = setupDaemonTests();

async function pair(
  daemon: TestDaemon,
  code: string,
  deviceName = 'iPhone',
): Promise<{ statusCode: number; token: string; deviceId: string }> {
  const res = await daemon.app.inject({ method: 'POST', url: '/api/pair', payload: { code, deviceName } });
  const body = res.statusCode === 200 ? (res.json<PairResponse>() as PairResponse) : undefined;
  return { statusCode: res.statusCode, token: body?.token ?? '', deviceId: body?.deviceId ?? '' };
}

describe('GET /api/health', () => {
  it('responde sem token com a identidade da máquina e a versão', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({ method: 'GET', url: '/api/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json<HealthResponse>()).toEqual({
      ok: true,
      machineId: daemon.machine.id,
      machineName: daemon.config.machineName,
      version: TEST_VERSION,
    });
  });
});

describe('POST /api/pair', () => {
  it('troca código válido por token no formato do contrato', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: { code: issueCode(daemon), deviceName: 'iPhone' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<PairResponse>();
    expect(PairResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ machineId: daemon.machine.id, machineName: daemon.config.machineName });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('código errado → 401', async () => {
    const daemon = await env.start();
    const code = issueCode(daemon);
    const result = await pair(daemon, differentCode(code));
    expect(result.statusCode).toBe(401);
  });

  it('código expirado → 401', async () => {
    const daemon = await env.start();
    const code = createPairCode(daemon.db, Date.now() - PAIR_CODE_TTL_MS - 60_000);
    expect((await pair(daemon, code)).statusCode).toBe(401);
  });

  it('código reusado → 401', async () => {
    const daemon = await env.start();
    const code = issueCode(daemon);
    expect((await pair(daemon, code)).statusCode).toBe(200);
    expect((await pair(daemon, code, 'outro')).statusCode).toBe(401);
  });

  it('body fora do schema → 400', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({ method: 'POST', url: '/api/pair', payload: { code: '12', deviceName: 'x' } });
    expect(res.statusCode).toBe(400);
  });

  it('body inválido conta como tentativa errada: 5 bodies ruins → 429 até para o código certo', async () => {
    const daemon = await env.start();
    const code = issueCode(daemon);
    for (let i = 0; i < 5; i++) {
      const res = await daemon.app.inject({ method: 'POST', url: '/api/pair', payload: { code: '12', deviceName: 'x' } });
      expect(res.statusCode).toBe(400);
    }
    expect((await pair(daemon, code)).statusCode).toBe(429);
  });

  it('5 erros seguidos do mesmo IP → 429, inclusive com o código correto', async () => {
    const daemon = await env.start();
    const code = issueCode(daemon);
    const wrong = differentCode(code);

    for (let i = 0; i < 5; i++) {
      expect((await pair(daemon, wrong)).statusCode).toBe(401);
    }
    expect((await pair(daemon, wrong)).statusCode).toBe(429);
    expect((await pair(daemon, code)).statusCode).toBe(429);
  });

  it('com Tailscale-User-Login, a conta é por login: outro login não herda o bloqueio do mesmo IP', async () => {
    const daemon = await env.start();
    const code = issueCode(daemon);
    const wrong = differentCode(code);
    const as = (login: string) => ({ 'tailscale-user-login': login });

    for (let i = 0; i < 5; i++) {
      const res = await daemon.app.inject({ method: 'POST', url: '/api/pair', headers: as('joao@exemplo.com'), payload: { code: wrong, deviceName: 'x' } });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await daemon.app.inject({ method: 'POST', url: '/api/pair', headers: as('joao@exemplo.com'), payload: { code, deviceName: 'x' } });
    expect(blocked.statusCode).toBe(429);

    const other = await daemon.app.inject({ method: 'POST', url: '/api/pair', headers: as('maria@exemplo.com'), payload: { code, deviceName: 'x' } });
    expect(other.statusCode).toBe(200);
  });
});

describe('GET /api/me', () => {
  it('com token válido devolve o dispositivo e a máquina', async () => {
    const daemon = await env.start();
    const paired = await pair(daemon, issueCode(daemon), 'iPhone do João');

    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${paired.token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<MeResponse>()).toEqual({
      deviceId: paired.deviceId,
      deviceName: 'iPhone do João',
      machineId: daemon.machine.id,
      machineName: daemon.config.machineName,
    });
  });

  it('sem header → 401', async () => {
    const daemon = await env.start();
    expect((await daemon.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });

  it('esquema diferente de Bearer → 401', async () => {
    const daemon = await env.start();
    const paired = await pair(daemon, issueCode(daemon));
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Basic ${paired.token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('token inexistente → 401', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer nao-existe' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('token revogado → 401', async () => {
    const daemon = await env.start();
    const paired = await pair(daemon, issueCode(daemon));
    revokeDevice(daemon.db, paired.deviceId, Date.now());

    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('atualiza last_seen_at ao usar o token', async () => {
    const daemon = await env.start();
    const paired = await pair(daemon, issueCode(daemon));
    const before = daemon.db
      .prepare<[string], { last_seen_at: number | null }>('SELECT last_seen_at FROM devices WHERE id = ?')
      .get(paired.deviceId);
    expect(before?.last_seen_at).toBeNull();

    await daemon.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${paired.token}` } });

    const after = daemon.db
      .prepare<[string], { last_seen_at: number | null }>('SELECT last_seen_at FROM devices WHERE id = ?')
      .get(paired.deviceId);
    expect(after?.last_seen_at).toEqual(expect.any(Number));
  });
});

describe('checagem Tailscale', () => {
  it('lista vazia libera todas as rotas /api sem header', async () => {
    const daemon = await env.start();
    expect((await daemon.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('lista preenchida exige o header Tailscale-User-Login de um login permitido', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: ['joao@exemplo.com'] } });

    expect((await daemon.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(403);
    expect(
      (await daemon.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { 'tailscale-user-login': 'outro@exemplo.com' },
      })).statusCode,
    ).toBe(403);
    expect(
      (await daemon.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { 'tailscale-user-login': 'joao@exemplo.com' },
      })).statusCode,
    ).toBe(200);
  });

  it('também vale para /api/me e /api/pair', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: ['joao@exemplo.com'] } });
    const code = issueCode(daemon);

    const pairRes = await daemon.app.inject({ method: 'POST', url: '/api/pair', payload: { code, deviceName: 'x' } });
    expect(pairRes.statusCode).toBe(403);
    const meRes = await daemon.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer x' } });
    expect(meRes.statusCode).toBe(403);
  });

  it('não bloqueia fora de /api e /ws', async () => {
    const daemon = await env.start({ config: { allowedTailscaleLogins: ['joao@exemplo.com'] } });
    expect((await daemon.app.inject({ method: 'GET', url: '/' })).statusCode).not.toBe(403);
  });
});

describe('CORS', () => {
  it('libera só as origens de corsOrigins', async () => {
    const daemon = await env.start({ config: { corsOrigins: ['https://app.exemplo.com'] } });

    const ok = await daemon.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://app.exemplo.com' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('https://app.exemplo.com');

    const other = await daemon.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.exemplo.com' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('com corsOrigins vazio não envia Access-Control-Allow-Origin', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://app.exemplo.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('estáticos e fallback SPA', () => {
  it('sem a pasta do PWA responde 404 com texto curto, sem quebrar', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatch(/PWA/);
  });

  it('serve index.html, assets e cai no index.html para rotas do SPA', async () => {
    const daemon = await env.start({ pwa: true });

    const index = await daemon.app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<title>app</title>');

    const asset = await daemon.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');

    const spa = await daemon.app.inject({ method: 'GET', url: '/maquinas/abc' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<title>app</title>');
    expect(spa.headers['cache-control']).toBe('no-cache');
  });

  it('rotas /api desconhecidas respondem 404 JSON, não index.html', async () => {
    const daemon = await env.start({ pwa: true });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/nao-existe' });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>()).toEqual({ error: 'not_found' });
  });
});

describe('serializeRequest (logs sem token)', () => {
  it('remove a query string, onde fica o ?token= do WebSocket', () => {
    const logged = serializeRequest({
      method: 'GET',
      url: '/ws?token=segredo',
      socket: { remoteAddress: '127.0.0.1', remotePort: 5000 },
    });
    expect(logged).toEqual({ method: 'GET', url: '/ws', remoteAddress: '127.0.0.1', remotePort: 5000 });
    expect(JSON.stringify(logged)).not.toContain('segredo');
  });
});
