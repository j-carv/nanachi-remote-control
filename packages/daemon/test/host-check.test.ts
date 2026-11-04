import { describe, expect, it } from 'vitest';
import { setupDaemonTests } from './support.js';
import { pairToken } from './agent-support.js';
import { createHostCheck } from '../src/host-check.js';

const CORS = ['https://principal.exemplo.com'];
const allowed = createHostCheck(CORS);

describe('createHostCheck (regra pura)', () => {
  it.each([
    '127.0.0.1:7777',
    '127.0.0.1',
    'localhost:7777',
    'localhost',
    'LOCALHOST:7777',
    '[::1]:7777',
    '[::1]',
    'pc.tailnet-abc.ts.net',
    'pc.tailnet-abc.ts.net:443',
    'a.b.ts.net:8443',
  ])('aceita Host %s', (host) => {
    expect(allowed({ host, forwardedHost: undefined })).toBe(true);
  });

  it.each([
    'evil.com',
    'evil.com:7777',
    'localhost.evil.com',
    'x.ts.net.evil.com',
    'ts.net',
    '.ts.net',
    'evilts.net',
    '127.0.0.2',
    '[::2]:7777',
    '',
    'evil.com/@localhost',
    'localhost:99999',
    'localhost:',
    'user@localhost',
  ])('recusa Host %s', (host) => {
    expect(allowed({ host, forwardedHost: undefined })).toBe(false);
  });

  it('sem Host, recusa', () => {
    expect(allowed({ host: undefined, forwardedHost: undefined })).toBe(false);
  });

  it('aceita o host de uma origem de corsOrigins (PC principal) em qualquer porta', () => {
    expect(allowed({ host: 'principal.exemplo.com', forwardedHost: undefined })).toBe(true);
    expect(allowed({ host: 'principal.exemplo.com:8443', forwardedHost: undefined })).toBe(true);
    expect(allowed({ host: 'outro.exemplo.com', forwardedHost: undefined })).toBe(false);
  });

  it('X-Forwarded-Host (tailscale serve) também precisa passar pela regra', () => {
    expect(allowed({ host: 'localhost:7777', forwardedHost: 'pc.tailnet.ts.net' })).toBe(true);
    expect(allowed({ host: 'localhost:7777', forwardedHost: 'evil.com' })).toBe(false);
    expect(allowed({ host: 'evil.com', forwardedHost: 'pc.tailnet.ts.net' })).toBe(false);
  });

  it('X-Forwarded-Host com vários valores: todos precisam passar', () => {
    expect(allowed({ host: 'localhost', forwardedHost: 'pc.tailnet.ts.net, principal.exemplo.com' })).toBe(true);
    expect(allowed({ host: 'localhost', forwardedHost: 'pc.tailnet.ts.net, evil.com' })).toBe(false);
  });

  it('X-Forwarded-Host vazio é recusado', () => {
    expect(allowed({ host: 'localhost', forwardedHost: '' })).toBe(false);
  });

  it('corsOrigins mal formado é ignorado sem derrubar a checagem', () => {
    const check = createHostCheck(['não é url', 'https://ok.exemplo.com']);
    expect(check({ host: 'ok.exemplo.com', forwardedHost: undefined })).toBe(true);
  });
});

describe('Host nas rotas e no upgrade do WS', () => {
  const env = setupDaemonTests();

  it('Host de fora → 403 bad_host em qualquer rota, inclusive fora de /api', async () => {
    const daemon = await env.start({ config: { corsOrigins: [] }, pwa: true });
    for (const url of ['/api/health', '/api/me', '/', '/nao-existe']) {
      const res = await daemon.app.inject({ method: 'GET', url, headers: { host: 'evil.com' } });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual({ error: 'bad_host' });
    }
  });

  it('Host de loopback, de ts.net e sem porta passam', async () => {
    const daemon = await env.start();
    for (const host of ['127.0.0.1:7777', 'localhost', '[::1]:7777', 'pc.tailnet.ts.net']) {
      expect((await daemon.app.inject({ method: 'GET', url: '/api/health', headers: { host } })).statusCode, host).toBe(200);
    }
  });

  it('X-Forwarded-Host de fora → 403, mesmo com Host de loopback', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:7777', 'x-forwarded-host': 'evil.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('upgrade do WS com Host de fora → 403 antes do 101', async () => {
    const daemon = await env.start();
    const token = await pairToken(daemon);
    await expect(
      daemon.app.injectWS(`/ws?token=${token}`, { headers: { host: 'evil.com' } }),
    ).rejects.toThrow('403');
  });
});
