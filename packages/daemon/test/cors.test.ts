import { describe, expect, it } from 'vitest';
import { authHeader } from './agent-support.js';
import { setupDaemonTests } from './support.js';

const env = setupDaemonTests();
const ORIGIN = 'https://principal.exemplo.com';

/** Preflight como o navegador manda antes de uma chamada com Authorization e corpo JSON. */
function preflight(url: string, method: string, headers = 'authorization,content-type') {
  return {
    method: 'OPTIONS' as const,
    url,
    headers: {
      origin: ORIGIN,
      'access-control-request-method': method,
      'access-control-request-headers': headers,
    },
  };
}

describe('CORS (PLAN: origens de corsOrigins, sem credenciais)', () => {
  it('preflight de origem permitida anuncia só GET/POST/PATCH/DELETE e os headers do contrato', async () => {
    const daemon = await env.start({ config: { corsOrigins: [ORIGIN] } });
    const res = await daemon.app.inject(
      preflight('/api/workspaces/abc', 'PATCH', 'authorization,content-type,x-file-name'),
    );

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    const methods = String(res.headers['access-control-allow-methods']).split(',').map((m) => m.trim());
    expect(methods.sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST']);
    const allowed = String(res.headers['access-control-allow-headers'])
      .split(',')
      .map((h) => h.trim().toLowerCase());
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'content-type', 'x-file-name']));
    expect(allowed).not.toContain('x-caption');
  });

  it('método fora da lista (PUT) não entra em Access-Control-Allow-Methods', async () => {
    const daemon = await env.start({ config: { corsOrigins: [ORIGIN] } });
    const res = await daemon.app.inject(preflight('/api/workspaces/abc', 'PUT'));

    const methods = String(res.headers['access-control-allow-methods'] ?? '');
    expect(methods).not.toMatch(/\bPUT\b/);
  });

  it('nunca envia Access-Control-Allow-Credentials (sem cookies)', async () => {
    const daemon = await env.start({ config: { corsOrigins: [ORIGIN] } });
    const res = await daemon.app.inject({ method: 'GET', url: '/api/health', headers: { origin: ORIGIN } });

    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('chamada real de origem permitida com Bearer funciona e devolve ACAO', async () => {
    const daemon = await env.start({ config: { corsOrigins: [ORIGIN] } });
    const res = await daemon.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { origin: ORIGIN, ...(await authHeader(daemon)) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  it('sem corsOrigins, preflight não recebe Access-Control-Allow-Origin', async () => {
    const daemon = await env.start();
    const res = await daemon.app.inject(preflight('/api/workspaces', 'GET'));

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
