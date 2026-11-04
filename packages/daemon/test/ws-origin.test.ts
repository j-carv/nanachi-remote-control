import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { isAllowedWsOrigin, type WsOriginRequest } from '../src/ws-origin.js';
import { listen, pairToken } from './agent-support.js';
import { setupDaemonTests } from './support.js';

const base: WsOriginRequest = {
  origin: undefined,
  host: '127.0.0.1:7777',
  forwardedHost: undefined,
  forwardedProto: undefined,
  encrypted: false,
};

describe('isAllowedWsOrigin (regra pura)', () => {
  it('Origin ausente (cliente que não é navegador) passa', () => {
    expect(isAllowedWsOrigin(base, [])).toBe(true);
  });

  it('própria origem pelo Host, em http', () => {
    expect(isAllowedWsOrigin({ ...base, origin: 'http://127.0.0.1:7777' }, [])).toBe(true);
  });

  it('própria origem atrás do tailscale serve: X-Forwarded-Host e X-Forwarded-Proto', () => {
    const request = {
      ...base,
      origin: 'https://pc.tailnet.ts.net',
      forwardedHost: 'pc.tailnet.ts.net',
      forwardedProto: 'https',
    };
    expect(isAllowedWsOrigin(request, [])).toBe(true);
  });

  it('X-Forwarded-Host com mais de um valor vale o primeiro', () => {
    const request = {
      ...base,
      origin: 'https://pc.tailnet.ts.net',
      forwardedHost: 'pc.tailnet.ts.net, 127.0.0.1:7777',
      forwardedProto: 'https',
    };
    expect(isAllowedWsOrigin(request, [])).toBe(true);
  });

  it('socket TLS sem X-Forwarded-Proto conta como https', () => {
    const request = { ...base, origin: 'https://pc.tailnet.ts.net', host: 'pc.tailnet.ts.net', encrypted: true };
    expect(isAllowedWsOrigin(request, [])).toBe(true);
  });

  it('mesmo host com esquema diferente não é a própria origem', () => {
    const request = {
      ...base,
      origin: 'http://pc.tailnet.ts.net',
      host: 'pc.tailnet.ts.net',
      forwardedProto: 'https',
    };
    expect(isAllowedWsOrigin(request, [])).toBe(false);
  });

  it('porta diferente não é a própria origem', () => {
    expect(isAllowedWsOrigin({ ...base, origin: 'http://127.0.0.1:9999' }, [])).toBe(false);
  });

  it('host é comparado sem diferença de maiúsculas', () => {
    const request = { ...base, origin: 'HTTPS://PC.TAILNET.TS.NET', host: 'pc.tailnet.ts.net', encrypted: true };
    expect(isAllowedWsOrigin(request, [])).toBe(true);
  });

  it('origem de corsOrigins passa mesmo com Host diferente (PC secundário)', () => {
    const request = { ...base, origin: 'https://principal.tailnet.ts.net', host: 'secundario.tailnet.ts.net' };
    expect(isAllowedWsOrigin(request, ['https://principal.tailnet.ts.net'])).toBe(true);
  });

  it('corsOrigins com barra no fim ou entrada inválida ainda casa a origem certa', () => {
    const request = { ...base, origin: 'https://principal.tailnet.ts.net' };
    expect(isAllowedWsOrigin(request, ['lixo', 'https://principal.tailnet.ts.net/'])).toBe(true);
  });

  it('origem estranha, "null" e texto inválido → recusa', () => {
    expect(isAllowedWsOrigin({ ...base, origin: 'https://evil.exemplo.com' }, ['https://app.exemplo.com'])).toBe(false);
    expect(isAllowedWsOrigin({ ...base, origin: 'null' }, [])).toBe(false);
    expect(isAllowedWsOrigin({ ...base, origin: 'nao e url' }, [])).toBe(false);
  });

  it('sem Host nem X-Forwarded-Host, só corsOrigins vale', () => {
    const request = { ...base, host: undefined, origin: 'http://127.0.0.1:7777' };
    expect(isAllowedWsOrigin(request, [])).toBe(false);
  });
});

const env = setupDaemonTests();

/** Abre o WS com um Origin específico; resolve com o status HTTP da recusa ou 'open'. */
function connectWith(url: string, origin: string | undefined): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const headers = origin === undefined ? {} : { origin };
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => {
      resolve('open');
      ws.close();
    });
    ws.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
    });
    ws.once('error', () => undefined);
  });
}

describe('WS /ws com checagem de Origin no upgrade', () => {
  it('origem estranha → 403 antes do upgrade', async () => {
    const daemon = await env.start();
    const base = (await listen(daemon)).replace(/^http/, 'ws');
    const token = await pairToken(daemon);

    expect(await connectWith(`${base}/ws?token=${token}`, 'https://evil.exemplo.com')).toBe(403);
  });

  it('Origin ausente, própria origem e corsOrigins abrem', async () => {
    const daemon = await env.start({ config: { corsOrigins: ['https://principal.exemplo.com'] } });
    const address = await listen(daemon);
    const base = address.replace(/^http/, 'ws');
    const token = await pairToken(daemon);

    expect(await connectWith(`${base}/ws?token=${token}`, undefined)).toBe('open');
    expect(await connectWith(`${base}/ws?token=${token}`, address)).toBe('open');
    expect(await connectWith(`${base}/ws?token=${token}`, 'https://principal.exemplo.com')).toBe('open');
  });

  it('a recusa por origem vem antes da checagem de token (403, não 4401)', async () => {
    const daemon = await env.start();
    const base = (await listen(daemon)).replace(/^http/, 'ws');

    expect(await connectWith(`${base}/ws?token=invalido`, 'https://evil.exemplo.com')).toBe(403);
  });
});
