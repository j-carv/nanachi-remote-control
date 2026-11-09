import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { previewLocalPort } from '@nanachi/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { Previews } from '../src/previews.js';

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

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(url: string, headers: IncomingHttpHeaders = {}, body?: string, method = body === undefined ? 'GET' : 'POST'): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method, headers, agent: false }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

const PROJECT_CSP = "default-src 'self'; script-src 'self'; worker-src 'self'";
const SCRIPT = "self.addEventListener('fetch', () => {});";

async function rig() {
  let daemonPort = 0;
  let reservation: Server | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const main = createServer();
    daemonPort = await listen(main);
    const gateway = createServer();
    try {
      await listen(gateway, previewLocalPort(daemonPort));
      reservation = gateway;
      cleanup.push(() => closeServer(main));
      break;
    } catch {
      await closeServer(main);
      daemonPort = 0;
    }
  }
  if (daemonPort === 0 || reservation === undefined) throw new Error('cannot reserve adjacent loopback ports');
  cleanup.push(() => reservation?.listening ? closeServer(reservation) : Promise.resolve());
  const received: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
  const target = createServer((incoming, reply) => {
    if (incoming.method === 'HEAD' && incoming.url === '/html') { reply.end(); return; }
    received.push({ path: incoming.url ?? '/', headers: incoming.headers });
    reply.setHeader('Cache-Control', 'public, max-age=31536000, immutable, stale-while-revalidate=86400');
    reply.setHeader('CDN-Cache-Control', 'public, max-age=31536000');
    reply.setHeader('Surrogate-Control', 'max-age=31536000');
    reply.setHeader('Pragma', 'cache');
    reply.setHeader('Expires', 'Tue, 01 Jan 2036 00:00:00 GMT');
    reply.setHeader('Age', '120');
    reply.setHeader('ETag', '"cached-project"');
    reply.setHeader('Last-Modified', 'Mon, 01 Jan 2024 00:00:00 GMT');
    reply.setHeader('Service-Worker-Allowed', '/');
    reply.setHeader('Vary', incoming.url === '/vary-star' ? '*' : 'Accept-Encoding, X-Project-Mode');
    reply.setHeader('Content-Security-Policy', PROJECT_CSP);
    reply.setHeader('Content-Security-Policy-Report-Only', "default-src 'none'");
    if (incoming.url === '/not-modified'
      || (incoming.url === '/conditional' && (incoming.method === 'GET' || incoming.method === 'HEAD')
        && (incoming.headers['if-none-match'] !== undefined || incoming.headers['if-modified-since'] !== undefined))) {
      reply.writeHead(304).end(); return;
    }
    if (incoming.url === '/redirect') { reply.writeHead(302, { Location: '/html' }).end(); return; }
    if (incoming.url === '/error') { reply.writeHead(503).end('project unavailable'); return; }
    if (incoming.url === '/api') { reply.setHeader('Content-Type', 'application/json'); reply.end('{"value":7}'); return; }
    if (incoming.url === '/html') { reply.setHeader('Content-Type', 'text/html'); reply.end('<!doctype html><script src="/script.js"></script>'); return; }
    reply.setHeader('Content-Type', 'text/javascript');
    reply.end(SCRIPT);
  });
  const targetPort = await listen(target);
  cleanup.push(() => closeServer(target));
  await closeServer(reservation);
  const previews = new Previews({
    daemonPort: () => daemonPort, isSessionLive: () => true,
    record: () => undefined, recordClosed: () => undefined,
    corsOrigins: [], allowedTailscaleLogins: [],
  });
  cleanup.push(() => previews.close());
  const info = await previews.create('cache-fixture', { port: targetPort, path: '/html' });
  const origin = `http://127.0.0.1:${previewLocalPort(daemonPort)}`;
  const grant = await previews.open('cache-fixture', info.previewId, `http://127.0.0.1:${daemonPort}`, () => true);
  const redeemed = await request(`${origin}/__nanachi_preview/redeem`, {
    Origin: origin, 'Content-Type': 'application/json',
  }, JSON.stringify({ ticket: new URL(grant.url).hash.slice(1) }));
  expect(redeemed.status).toBe(200);
  const cookie = redeemed.headers['set-cookie']?.[0]?.split(';', 1)[0];
  if (cookie === undefined) throw new Error('missing gateway capability');
  return { origin, cookie, received };
}

function expectUncacheable(response: HttpResponse): void {
  expect(response.headers['cache-control']).toBe('no-store');
  for (const header of ['cdn-cache-control', 'surrogate-control', 'pragma', 'expires', 'age', 'etag', 'last-modified', 'service-worker-allowed']) {
    expect(response.headers[header], header).toBeUndefined();
  }
  const vary = response.headers.vary?.toLowerCase().split(',').map((value) => value.trim());
  expect(vary).toEqual(expect.arrayContaining(['accept-encoding', 'x-project-mode', 'service-worker', 'sec-fetch-dest']));
}

// Real disposable loopback gateway requests; browser cache behavior is covered separately in Chromium.
describe('preview gateway cache isolation', () => {
  it('overrides upstream cache metadata for scripts, HTML, APIs, redirects and errors without weakening project CSP', async () => {
    const r = await rig();
    for (const [path, status] of [['/script.js', 200], ['/html', 200], ['/api', 200], ['/redirect', 302], ['/error', 503]] as const) {
      const response = await request(`${r.origin}${path}`, { Cookie: r.cookie });
      expect(response.status).toBe(status);
      expectUncacheable(response);
      expect(response.headers['content-security-policy']).toBe(PROJECT_CSP);
      expect(response.headers['content-security-policy-report-only']).toBe("default-src 'none'");
      if (path === '/script.js') expect(response.body).toBe(SCRIPT);
      if (path === '/html') expect(response.body).toContain('<script src="/script.js">');
      if (path === '/api') expect(JSON.parse(response.body)).toEqual({ value: 7 });
      if (path === '/redirect') expect(response.headers.location).toBe(`${r.origin}/html`);
      if (path === '/error') expect(response.body).toBe('project unavailable');
    }
  });

  it('preserves an upstream wildcard Vary without enabling storage', async () => {
    const r = await rig();
    const response = await request(`${r.origin}/vary-star`, { Cookie: r.cookie });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.vary).toBe('*');
    expect(response.body).toBe(SCRIPT);
  });

  it('does not forward cache validators but preserves application write preconditions', async () => {
    const r = await rig();
    for (const method of ['GET', 'HEAD']) {
      const response = await request(`${r.origin}/conditional`, {
        Cookie: r.cookie, 'If-None-Match': '"cached-project"', 'If-Modified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT',
      }, undefined, method);
      expect(response.status).toBe(200);
      expectUncacheable(response);
      expect(response.body).toBe(method === 'HEAD' ? '' : SCRIPT);
      const upstream = r.received.at(-1);
      expect(upstream?.path).toBe('/conditional');
      expect(upstream?.headers['if-none-match']).toBeUndefined();
      expect(upstream?.headers['if-modified-since']).toBeUndefined();
    }
    const updated = await request(`${r.origin}/conditional`, {
      Cookie: r.cookie, 'If-Match': '"current-project"', 'If-Unmodified-Since': 'Mon, 01 Jan 2024 00:00:00 GMT',
    }, 'updated project', 'PUT');
    expect(updated.status).toBe(200);
    expect(r.received.at(-1)?.headers['if-match']).toBe('"current-project"');
    expect(r.received.at(-1)?.headers['if-unmodified-since']).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    const created = await request(`${r.origin}/conditional`, { Cookie: r.cookie, 'If-None-Match': '*' }, 'new project', 'PUT');
    expect(created.status).toBe(200);
    expect(r.received.at(-1)?.headers['if-none-match']).toBe('*');
  });

  it('rejects unsolicited upstream 304 responses rather than validating an old cached representation', async () => {
    const r = await rig();
    for (const method of ['GET', 'HEAD']) {
      const response = await request(`${r.origin}/not-modified`, { Cookie: r.cookie }, undefined, method);
      expect(response.status).toBe(502);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers['last-modified']).toBeUndefined();
      expect(response.headers.vary?.toLowerCase()).toBe('service-worker, sec-fetch-dest');
      if (method === 'HEAD') expect(response.body).toBe('');
      else expect(response.body).toContain('unexpected cache validation response');
    }
  });

  it('still rejects service-worker-purpose requests after serving the same script as an ordinary asset', async () => {
    const r = await rig();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(`${r.origin}/script.js`, { Cookie: r.cookie, 'Sec-Fetch-Dest': 'script' });
      expect(response.status).toBe(200);
      expectUncacheable(response);
      expect(response.body).toBe(SCRIPT);
    }
    expect(r.received.map((incoming) => incoming.path)).toEqual(['/script.js', '/script.js']);
    for (const purpose of [{ 'Service-Worker': 'script' }, { 'Sec-Fetch-Dest': 'serviceworker' }]) {
      const response = await request(`${r.origin}/script.js`, { Cookie: r.cookie, ...purpose });
      expect(response.status).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toContain('Service workers are not available');
    }
    expect(r.received).toHaveLength(2);
  });
});
