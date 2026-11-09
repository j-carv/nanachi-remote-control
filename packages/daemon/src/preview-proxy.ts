import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

export const PREVIEW_COOKIE = 'NanachiPreview';
export const SECURE_PREVIEW_COOKIE = '__Host-NanachiPreview';
const HOP_HEADERS: Record<string, true | undefined> = {
  connection: true, 'keep-alive': true, 'proxy-authenticate': true, 'proxy-authorization': true,
  te: true, trailer: true, 'transfer-encoding': true, upgrade: true,
};

export interface PreviewProxyContext {
  port: number;
  origin: string;
  track(socket: Duplex): void;
}

function isGatewayCookie(cookie: string): boolean {
  const name = cookie.split('=', 1)[0]?.trim().toLowerCase() ?? '';
  return name === PREVIEW_COOKIE.toLowerCase() || name === SECURE_PREVIEW_COOKIE.toLowerCase();
}

/** Preserve project cookies, but never forward the gateway capability or Nanachi transport credentials. */
function requestHeaders(request: IncomingMessage, context: PreviewProxyContext, upgrade: boolean): IncomingHttpHeaders {
  const connectionHeaders = new Set((request.headers.connection ?? '').toLowerCase().split(',').map((value) => value.trim()));
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_HEADERS[name] || connectionHeaders.has(name) || name === 'host' || name === 'authorization'
      || name === 'forwarded' || name.startsWith('x-forwarded-') || name.startsWith('tailscale-')
      || name.startsWith('x-nanachi-') || name === 'referer' || name === 'cookie'
      || (!upgrade && (request.method === 'GET' || request.method === 'HEAD')
        && (name === 'if-none-match' || name === 'if-modified-since'))) continue;
    if (value !== undefined) headers[name] = value;
  }
  const cookies = request.headers.cookie?.split(';').filter((cookie) => !isGatewayCookie(cookie)).join(';');
  if (cookies) headers.cookie = cookies;
  headers.host = `127.0.0.1:${context.port}`;
  if (headers.origin !== undefined) headers.origin = `http://127.0.0.1:${context.port}`;
  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }
  return headers;
}

function responseHeaders(response: IncomingMessage, context: PreviewProxyContext, upgrade: boolean): IncomingHttpHeaders {
  const connectionHeaders = new Set((response.headers.connection ?? '').toLowerCase().split(',').map((value) => value.trim()));
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (HOP_HEADERS[name] || connectionHeaders.has(name) || name === 'set-cookie' || name === 'location'
      || name === 'referrer-policy' || name === 'service-worker-allowed'
      || (!upgrade && (name === 'cache-control' || name === 'cdn-cache-control' || name === 'surrogate-control'
        || name === 'expires' || name === 'age' || name === 'etag' || name === 'last-modified' || name === 'pragma'))) continue;
    if (value !== undefined) headers[name] = value;
  }
  const cookies = response.headers['set-cookie']?.filter((cookie) => !isGatewayCookie(cookie)).map(
    (cookie) => cookie.replace(/;\s*domain=[^;]*/gi, ''),
  );
  if (cookies?.length) headers['set-cookie'] = cookies;
  const location = response.headers.location;
  if (location !== undefined) {
    try {
      const target = new URL(location, `http://127.0.0.1:${context.port}`);
      if (['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port === String(context.port)) {
        headers.location = `${context.origin}${target.pathname}${target.search}${target.hash}`;
      } else {
        headers.location = location;
      }
    } catch {
      // A malformed upstream redirect must not create a response-splitting or gateway error.
    }
  }
  headers['referrer-policy'] = 'no-referrer';
  if (!upgrade) {
    // A script cached as an ordinary asset must never bypass the gateway's service-worker request check.
    headers['cache-control'] = 'no-store';
    const vary = new Set((response.headers.vary ?? '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean));
    vary.add('service-worker');
    vary.add('sec-fetch-dest');
    headers.vary = vary.has('*') ? '*' : [...vary].join(', ');
  }
  if (upgrade) {
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
  }
  return headers;
}

/** Probe only the specified IPv4 loopback service; never follow its redirects or consult an environment proxy. */
export function probePreview(port: number, path: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const deadline = performance.now() + 3_000;
  return new Promise((resolve) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'HEAD', agent: false });
    let settled = false;
    const finish = (available: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', unavailable);
      request.setTimeout(0);
      request.off('timeout', unavailable);
      request.off('response', responded);
      request.destroy();
      resolve(available);
    };
    const unavailable = (): void => finish(false);
    const responded = (response: IncomingMessage): void => {
      response.destroy();
      finish(!signal?.aborted && performance.now() < deadline);
    };
    const timer = setTimeout(unavailable, Math.max(0, deadline - performance.now()));
    request.setTimeout(3_000, unavailable);
    request.once('response', responded);
    // destroy() may emit an asynchronous ECONNRESET; retain the error handler until close.
    request.once('error', unavailable);
    request.once('close', () => {
      finish(false);
      request.off('error', unavailable);
    });
    signal?.addEventListener('abort', unavailable, { once: true });
    if (signal?.aborted) unavailable();
    else request.end();
  });
}

export function proxyPreviewHttp(request: IncomingMessage, reply: ServerResponse, context: PreviewProxyContext): void {
  const upstream = httpRequest({
    hostname: '127.0.0.1', port: context.port, path: request.url ?? '/', method: request.method,
    headers: requestHeaders(request, context, false), agent: false,
  }, (response) => {
    response.on('error', () => reply.destroy());
    if (response.statusCode === 304) {
      // A 304 cannot supply a representation; never validate a body cached before the gateway's no-store policy.
      response.resume();
      reply.writeHead(502, {
        'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', Vary: 'Service-Worker, Sec-Fetch-Dest',
      });
      reply.end('The local preview server returned an unexpected cache validation response.');
      return;
    }
    reply.writeHead(response.statusCode ?? 502, responseHeaders(response, context, false));
    response.pipe(reply);
  });
  upstream.once('socket', context.track);
  upstream.setTimeout(30_000, () => upstream.destroy());
  upstream.once('error', () => {
    if (reply.headersSent) reply.destroy();
    else {
      reply.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      reply.end('The local preview server is unavailable. Start it again, then reload this page.');
    }
  });
  request.once('aborted', () => upstream.destroy());
  reply.once('close', () => { if (!reply.writableFinished) upstream.destroy(); });
  request.pipe(upstream);
}

export function proxyPreviewUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, context: PreviewProxyContext): void {
  const upstream = httpRequest({
    hostname: '127.0.0.1', port: context.port, path: request.url ?? '/', method: 'GET',
    headers: requestHeaders(request, context, true), agent: false,
  });
  upstream.once('socket', context.track);
  const fail = (): void => { upstream.destroy(); socket.destroy(); };
  upstream.setTimeout(10_000, fail);
  upstream.once('error', () => socket.destroy());
  socket.once('error', () => upstream.destroy());
  socket.once('close', () => upstream.destroy());
  upstream.once('response', (response) => {
    response.resume();
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  upstream.once('upgrade', (response, remote, upstreamHead) => {
    if (socket.destroyed) { remote.destroy(); return; }
    remote.setTimeout(0);
    context.track(remote);
    const headers = responseHeaders(response, context, true);
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
      else if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) remote.write(head);
    remote.once('error', () => socket.destroy());
    remote.once('close', () => socket.destroy());
    socket.once('close', () => remote.destroy());
    remote.pipe(socket);
    socket.pipe(remote);
  });
  upstream.end();
}
