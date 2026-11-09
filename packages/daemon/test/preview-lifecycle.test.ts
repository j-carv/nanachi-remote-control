import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type Server, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { previewLocalPort, type PreviewInfo } from '@nanachi/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { probePreview } from '../src/preview-proxy.js';
import { Previews } from '../src/previews.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function listen(server: Server, port = 0): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing loopback listener');
  return address.port;
}

// Wait for observable real TCP progress, not a guessed sleep or a clock detached from the loopback sockets.
async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('loopback lifecycle did not settle');
    await delay(10);
  }
}

describe('preview HEAD probe lifecycle', () => {
  // Real loopback sockets and the platform deadline must advance together; fake timers cannot model TCP progress.
  it('bounds a continuously trickled response by the absolute three-second deadline', async () => {
    let connected = false;
    let closed = false;
    const target = createTcpServer((socket) => {
      connected = true;
      socket.resume();
      socket.write('HTTP/1.1 200 OK\r\nX-Slow: ');
      const trickle = setInterval(() => socket.write('.'), 100);
      socket.once('close', () => { clearInterval(trickle); closed = true; });
    });
    const port = await listen(target);
    const started = performance.now();
    expect(await probePreview(port, '/slow')).toBe(false);
    const elapsed = performance.now() - started;
    expect(connected).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(6_500);
    await eventually(() => closed);
  });

  it('does not connect for an already aborted caller', async () => {
    let connections = 0;
    const target = createHttpServer((_request, reply) => reply.end());
    target.on('connection', () => { connections += 1; });
    const port = await listen(target);
    const controller = new AbortController();
    controller.abort();
    expect(await probePreview(port, '/', controller.signal)).toBe(false);
    await delay(50);
    expect(connections).toBe(0);
  });

  it('destroys a successful probe and ignores a later caller abort', async () => {
    let active = 0;
    const target: HttpServer = createHttpServer((_request, reply) => reply.end());
    target.on('connection', (socket) => { active += 1; socket.once('close', () => { active -= 1; }); });
    const port = await listen(target);
    const controller = new AbortController();
    const result = probePreview(port, '/ready', controller.signal);
    expect(await result).toBe(true);
    await eventually(() => active === 0);
    controller.abort();
    expect(await result).toBe(true);
    expect(active).toBe(0);
  });
});

async function lifecycleRig(timeoutMs?: number) {
  let daemonPort = 0;
  let reservation: HttpServer | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const main = createHttpServer();
    const candidate = await listen(main);
    const gateway = createHttpServer();
    try {
      await listen(gateway, previewLocalPort(candidate));
      daemonPort = candidate;
      reservation = gateway;
      break;
    } catch {
      await new Promise<void>((resolve) => main.close(() => resolve()));
    }
  }
  if (daemonPort === 0 || reservation === undefined) throw new Error('cannot reserve adjacent preview ports');
  const reservedGateway = reservation;
  const state = { respond: true, probes: 0 };
  const active = new Set<Socket>();
  const target = createHttpServer((_request, reply) => {
    state.probes += 1;
    if (state.respond) reply.end();
  });
  target.on('connection', (socket) => {
    active.add(socket);
    socket.once('close', () => active.delete(socket));
  });
  const port = await listen(target);
  await new Promise<void>((resolve) => reservedGateway.close(() => resolve()));
  const recorded: PreviewInfo[] = [];
  const closed: Array<{ previewId: string; reason: string }> = [];
  const previews = new Previews({
    daemonPort: () => daemonPort, isSessionLive: () => true,
    record: (_sessionId, info) => { recorded.push(info); },
    recordClosed: (_sessionId, previewId, reason) => { closed.push({ previewId, reason }); },
    corsOrigins: [], allowedTailscaleLogins: [],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  cleanup.push(() => previews.close());
  return { previews, port, state, active, recorded, closed, mainOrigin: `http://127.0.0.1:${daemonPort}` };
}

describe('preview creation and open cancellation', () => {
  it('releases both per-session and global creation quota when callers cancel', async () => {
    const r = await lifecycleRig();
    r.state.respond = false;
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const pending = controllers.map((controller, index) => r.previews.create(
      `session-${Math.floor(index / 4)}`, { port: r.port }, controller.signal,
    ).catch((error: unknown) => error));
    await eventually(() => r.state.probes === 16);
    await expect(r.previews.create('session-0', { port: r.port })).rejects.toMatchObject({ status: 429 });
    await expect(r.previews.create('another-session', { port: r.port })).rejects.toMatchObject({ status: 429 });
    for (const controller of controllers) controller.abort();
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ status: 409, code: 'preview_not_available' });
    await eventually(() => r.active.size === 0);
    expect(r.recorded).toEqual([]);
    r.state.respond = true;
    for (let index = 0; index < 16; index += 1) {
      await r.previews.create(`session-${Math.floor(index / 4)}`, { port: r.port });
    }
    expect(r.recorded).toHaveLength(16);
  });

  it.each(['session revocation', 'daemon shutdown'] as const)('closes create and open probes on %s', async (reason) => {
    const r = await lifecycleRig();
    const info = await r.previews.create('session-a', { port: r.port });
    r.state.respond = false;
    const creating = r.previews.create('session-a', { port: r.port }).catch((error: unknown) => error);
    const opening = r.previews.open('session-a', info.previewId, r.mainOrigin, () => true).catch((error: unknown) => error);
    await eventually(() => r.state.probes === 3);
    if (reason === 'session revocation') r.previews.revokeSession('session-a');
    else await r.previews.close();
    expect(await creating).toMatchObject({ status: 409, code: 'session_ended' });
    expect(await opening).toMatchObject({ status: 409, code: 'session_ended' });
    await eventually(() => r.active.size === 0);
    expect(r.recorded).toEqual([info]);
    expect(r.closed).toEqual([{ previewId: info.previewId, reason: 'session_ended' }]);
  });

  it.each(['close', 'expiry'] as const)('rejects a pending open instead of granting access after preview %s', async (reason) => {
    const r = await lifecycleRig(reason === 'expiry' ? 1_200 : undefined);
    const info = await r.previews.create('session-a', { port: r.port });
    r.state.respond = false;
    const opening = r.previews.open('session-a', info.previewId, r.mainOrigin, () => true).catch((error: unknown) => error);
    await eventually(() => r.state.probes === 2);
    if (reason === 'close') r.previews.closePreview('session-a', info.previewId);
    expect(await opening).toMatchObject(reason === 'close'
      ? { status: 409, code: 'preview_not_available' }
      : { status: 410, code: 'preview_expired' });
    await eventually(() => r.active.size === 0);
    expect(r.closed).toEqual([{ previewId: info.previewId, reason: reason === 'close' ? 'closed' : 'expired' }]);
    r.state.respond = true;
    await expect(r.previews.open('session-a', info.previewId, r.mainOrigin, () => true)).rejects.toMatchObject({ status: 409 });
  });
});
