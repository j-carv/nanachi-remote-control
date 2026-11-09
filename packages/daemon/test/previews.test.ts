import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { once } from 'node:events';
import { PREVIEW_HTTPS_PORT, PreviewInputSchema, previewLocalPort, type PreviewInfo, type PreviewOpenResponse } from '@nanachi/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { Previews, previewOrigin } from '../src/previews.js';
import { PREVIEW_COOKIE, SECURE_PREVIEW_COOKIE } from '../src/preview-proxy.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing loopback listener');
  return address.port;
}
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

interface PreviewRig {
  previews: Previews;
  info: PreviewInfo;
  origin: string;
  mainOrigin: string;
  targetPort: number;
  closed: Array<{ previewId: string; reason: string }>;
  headers(): IncomingHttpHeaders;
  setLive(value: boolean): void;
  setDevice(value: boolean): void;
  open(sessionId?: string, base?: string): Promise<PreviewOpenResponse>;
}

async function rig(options: { timeoutMs?: number; logins?: string[] } = {}): Promise<PreviewRig> {
  let main = createServer();
  let daemonPort = 0;
  let reservedGateway: Server | undefined;
  // Keep the gateway reserved until the target has its own distinct ephemeral port.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    main = createServer((_request, reply) => reply.end('Nanachi dashboard origin'));
    daemonPort = await listen(main);
    const reservation = createServer();
    try { await listen(reservation, previewLocalPort(daemonPort)); reservedGateway = reservation; break; }
    catch { await closeServer(main); daemonPort = 0; }
  }
  if (daemonPort === 0 || reservedGateway === undefined) throw new Error('cannot reserve adjacent loopback ports');
  cleanup.push(() => closeServer(main));
  let count = 0;
  let lastHeaders: IncomingHttpHeaders = {};
  let targetPort = 0;
  const target = createServer(async (request, reply) => {
    if (request.method === 'HEAD') { reply.end(); return; }
    lastHeaders = request.headers;
    if (request.url === '/api/state' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed !== 'object' || parsed === null || !('increment' in parsed) || typeof parsed.increment !== 'number') {
        reply.writeHead(400).end(); return;
      }
      count += parsed.increment;
      for (const client of sockets.clients) client.send(JSON.stringify({ count }));
      reply.setHeader('Content-Type', 'application/json');
      reply.end(JSON.stringify({ count })); return;
    }
    if (request.url === '/api/state') { reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify({ count })); return; }
    if (request.url === '/redirect') { reply.writeHead(302, { Location: `http://localhost:${targetPort}/app?mode=demo` }).end(); return; }
    if (request.url === '/external') { reply.writeHead(302, { Location: 'https://example.invalid/not-followed' }).end(); return; }
    if (request.url === '/cookies') {
      reply.setHeader('Set-Cookie', [`${PREVIEW_COOKIE}=attacker; Path=/`, `${SECURE_PREVIEW_COOKIE}=attacker; Secure; Path=/`, 'project=value; Domain=localhost; Path=/']);
      reply.end('project cookies'); return;
    }
    if (request.url === '/assets/app.js?version=2') { reply.setHeader('Content-Type', 'text/javascript'); reply.end('document.body.dataset.projectVersion = "2";'); return; }
    reply.setHeader('Content-Type', 'text/html');
    reply.end('<!doctype html><title>Project fixture</title><main>Project preview</main><script type="module" src="/assets/app.js?version=2"></script>');
  });
  const sockets = new WebSocketServer({ server: target, path: '/hmr', verifyClient: (info: { origin: string }) => info.origin === `http://127.0.0.1:${targetPort}` });
  sockets.on('connection', (client) => client.send(JSON.stringify({ count })));
  targetPort = await listen(target);
  await closeServer(reservedGateway);
  cleanup.push(async () => { for (const client of sockets.clients) client.terminate(); sockets.close(); await closeServer(target); });
  let live = true;
  let device = true;
  const closed: Array<{ previewId: string; reason: string }> = [];
  const previews = new Previews({
    daemonPort: () => daemonPort, isSessionLive: () => live,
    record: () => undefined,
    recordClosed: (_sessionId, previewId, reason) => { closed.push({ previewId, reason }); },
    corsOrigins: [], allowedTailscaleLogins: options.logins ?? [],
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  cleanup.push(() => previews.close());
  const info = await previews.create('session-a', { port: targetPort, title: 'Synthetic project', path: '/app?mode=demo' });
  const mainOrigin = `http://127.0.0.1:${daemonPort}`;
  const origin = `http://127.0.0.1:${previewLocalPort(daemonPort)}`;
  return {
    previews, info, origin, mainOrigin, targetPort, closed,
    headers: () => lastHeaders,
    setLive: (value: boolean) => { live = value; },
    setDevice: (value: boolean) => { device = value; },
    open: (sessionId = 'session-a', base = mainOrigin) => previews.open(sessionId, info.previewId, base, () => device),
  };
}
async function redeem(origin: string, url: string, headers: Record<string, string> = {}) {
  return fetch(`${origin}/__nanachi_preview/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...headers },
    body: JSON.stringify({ ticket: new URL(url).hash.slice(1) }),
  });
}
async function access(r: PreviewRig) {
  const grant = await r.open();
  const response = await redeem(r.origin, grant.url);
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (cookie === undefined) throw new Error('missing gateway capability');
  return { cookie, grant, response };
}

// These regressions exercise real loopback HTTP/WebSocket sessions, not a mock proxy or agent account.
describe('isolated preview gateway', () => {
  it('requires a single-use, origin-bound grant without placing device credentials in project requests', async () => {
    const r = await rig();
    const grant = await r.open();
    expect((await fetch(`${r.origin}/app`)).status).toBe(401);
    const wrongOrigin = await redeem(r.origin, grant.url, { Origin: 'https://evil.example' });
    expect(wrongOrigin.status).toBe(403);
    const response = await redeem(r.origin, grant.url);
    expect(await response.json()).toEqual({ path: '/app?mode=demo' });
    const header = response.headers.get('set-cookie') ?? '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    const cookie = header.split(';', 1)[0] ?? '';
    expect((await redeem(r.origin, grant.url)).status).toBe(401);
    const result = await fetch(`${r.origin}/api/state`, {
      headers: { Cookie: `${cookie}; project=keep`, Authorization: 'Bearer synthetic-device-secret', 'X-Nanachi-Agent-Token': 'synthetic-agent-secret', 'Tailscale-User-Login': 'synthetic@example.com', 'X-Forwarded-For': '100.64.0.1' },
    });
    expect(await result.json()).toEqual({ count: 0 });
    expect(r.headers().authorization).toBeUndefined();
    expect(r.headers()['x-nanachi-agent-token']).toBeUndefined();
    expect(r.headers()['tailscale-user-login']).toBeUndefined();
    expect(r.headers()['x-forwarded-for']).toBeUndefined();
    expect(r.headers().cookie?.trim()).toBe('project=keep');
  });

  it('serves root assets, updates application state and delivers live WebSocket changes', async () => {
    const r = await rig();
    const { cookie } = await access(r);
    expect(await (await fetch(`${r.origin}/app?mode=demo`, { headers: { Cookie: cookie } })).text()).toContain('Project preview');
    expect(await (await fetch(`${r.origin}/assets/app.js?version=2`, { headers: { Cookie: cookie } })).text()).toContain('projectVersion');
    const socket = new WebSocket(`${r.origin.replace('http:', 'ws:')}/hmr`, 'vite-hmr', { headers: { Cookie: cookie, Origin: r.origin } });
    cleanup.push(async () => { socket.terminate(); });
    const initial = once(socket, 'message');
    await once(socket, 'open');
    expect(JSON.parse(String((await initial)[0]))).toEqual({ count: 0 });
    const update = once(socket, 'message');
    const response = await fetch(`${r.origin}/api/state`, { method: 'POST', headers: { Cookie: cookie, Origin: r.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ increment: 3 }) });
    expect(await response.json()).toEqual({ count: 3 });
    expect(JSON.parse(String((await update)[0]))).toEqual({ count: 3 });
    expect(await (await fetch(`${r.origin}/api/state`, { headers: { Cookie: cookie } })).json()).toEqual({ count: 3 });
    const closed = once(socket, 'close');
    r.previews.closePreview('session-a', r.info.previewId);
    await closed;
    expect((await fetch(`${r.origin}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    expect(r.closed).toEqual([{ previewId: r.info.previewId, reason: 'closed' }]);
  });

  it('keeps local redirects on the preview origin and never follows arbitrary external redirects', async () => {
    const r = await rig();
    const { cookie } = await access(r);
    const local = await fetch(`${r.origin}/redirect`, { headers: { Cookie: cookie }, redirect: 'manual' });
    expect(local.status).toBe(302);
    expect(local.headers.get('location')).toBe(`${r.origin}/app?mode=demo`);
    const external = await fetch(`${r.origin}/external`, { headers: { Cookie: cookie }, redirect: 'manual' });
    expect(external.status).toBe(302);
    expect(external.headers.get('location')).toBe('https://example.invalid/not-followed');
  });

  it('blocks service-worker takeover, foreign origins and replacement of gateway credentials', async () => {
    const r = await rig();
    const { cookie } = await access(r);
    expect((await fetch(`${r.origin}/worker.js`, { headers: { Cookie: cookie, 'Service-Worker': 'script' } })).status).toBe(403);
    expect((await fetch(`${r.origin}/api/state`, { headers: { Cookie: cookie, Origin: r.mainOrigin } })).status).toBe(401);
    const badHostStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${r.origin}/api/state`, { headers: { Cookie: cookie, Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.once('error', reject);
      request.end();
    });
    expect(badHostStatus).toBe(403);
    const response = await fetch(`${r.origin}/cookies`, { headers: { Cookie: cookie } });
    expect(response.headers.getSetCookie()).toEqual(['project=value; Path=/']);
    expect((await fetch(`${r.origin}/api/state`, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('cannot grant another session, the dashboard origin, an unsupported host or an expired device', async () => {
    const r = await rig();
    await expect(r.open('session-b')).rejects.toMatchObject({ status: 409 });
    await expect(r.open('session-a', 'https://example.com')).rejects.toMatchObject({ status: 400 });
    await expect(r.open('session-a', 'https://synthetic.example.ts.net:8443')).rejects.toMatchObject({ status: 400 });
    const { cookie, grant } = await access(r);
    r.setDevice(false);
    expect((await fetch(`${r.origin}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await redeem(r.origin, grant.url)).status).toBe(401);
    await expect(r.open()).rejects.toMatchObject({ status: 401 });
  });

  it('revokes capabilities and live streams on expiry, even when the phone still has the old cookie', async () => {
    const r = await rig({ timeoutMs: 500 });
    const { cookie } = await access(r);
    const socket = new WebSocket(`${r.origin.replace('http:', 'ws:')}/hmr`, { headers: { Cookie: cookie, Origin: r.origin } });
    cleanup.push(async () => { socket.terminate(); });
    await once(socket, 'open');
    await once(socket, 'close');
    expect((await fetch(`${r.origin}/api/state`, { headers: { Cookie: cookie } })).status).toBe(401);
    await expect(r.open()).rejects.toMatchObject({ status: 409 });
    expect(r.closed).toEqual([{ previewId: r.info.previewId, reason: 'expired' }]);
  });

  it('requires the configured Tailscale login in addition to a valid paired-device capability', async () => {
    const r = await rig({ logins: ['synthetic@example.com'] });
    const grant = await r.open('session-a', 'https://synthetic-pc.example.ts.net');
    const forwarded = { Host: `synthetic-pc.example.ts.net:${PREVIEW_HTTPS_PORT}`, 'X-Forwarded-Host': `synthetic-pc.example.ts.net:${PREVIEW_HTTPS_PORT}`, 'X-Forwarded-Proto': 'https' };
    const origin = `https://synthetic-pc.example.ts.net:${PREVIEW_HTTPS_PORT}`;
    expect((await redeem(r.origin, grant.url, { ...forwarded, Origin: origin })).status).toBe(403);
    const response = await redeem(r.origin, grant.url, { ...forwarded, Origin: origin, 'Tailscale-User-Login': 'synthetic@example.com' });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    expect(cookie.startsWith(`${SECURE_PREVIEW_COOKIE}=`)).toBe(true);
    expect(response.headers.get('set-cookie')).toContain('; Secure');
    expect((await fetch(`${r.origin}/api/state`, { headers: { ...forwarded, Cookie: cookie, 'Tailscale-User-Login': 'other@example.com' } })).status).toBe(403);
    expect((await fetch(`${r.origin}/api/state`, { headers: { ...forwarded, Cookie: cookie, 'Tailscale-User-Login': 'synthetic@example.com' } })).status).toBe(200);
  });

  it('rejects attempts to publish Nanachi itself or non-local preview paths', async () => {
    const r = await rig();
    await expect(r.previews.create('session-a', { port: new URL(r.mainOrigin).port ? Number(new URL(r.mainOrigin).port) : 80 })).rejects.toMatchObject({ status: 400 });
    await expect(r.previews.create('session-a', { port: Number(new URL(r.origin).port) })).rejects.toMatchObject({ status: 400 });
    for (const path of ['//evil.example', '/\\evil.example', 'https://evil.example', '/#fragment', '/\r\nX-Header: injected', '/bad%escape']) {
      expect(PreviewInputSchema.safeParse({ port: r.targetPort, path }).success).toBe(false);
    }
    expect(previewOrigin('http://[::1]:7777', 7777)).toBe('http://127.0.0.1:7778');
  });
});
