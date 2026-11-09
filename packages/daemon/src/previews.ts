import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  PREVIEW_HTTPS_PORT, PREVIEW_TIMEOUT_MS, previewLocalPort,
  type PreviewCloseReason, type PreviewInfo, type PreviewInput, type PreviewOpenResponse,
} from '@nanachi/shared';
import { ApiError } from './api-error.js';
import { createHostCheck, type HostHeaders } from './host-check.js';
import {
  PREVIEW_BOOTSTRAP_CSP, PREVIEW_BOOTSTRAP_HTML, PREVIEW_OPEN_PATH, PREVIEW_REDEEM_PATH,
} from './preview-bootstrap.js';
import { PREVIEW_COOKIE, SECURE_PREVIEW_COOKIE, probePreview, proxyPreviewHttp, proxyPreviewUpgrade } from './preview-proxy.js';
import { isLoopbackAddress, trustedTailscaleLogin } from './tailscale-login.js';

const MAX_PREVIEWS = 16;
const MAX_SESSION_PREVIEWS = 4;
const MAX_CAPABILITIES = 256;
const TICKET_TIMEOUT_MS = 60_000;
const REVALIDATE_MS = 5_000;

interface Preview {
  sessionId: string;
  info: PreviewInfo;
  timer: NodeJS.Timeout;
}
interface PendingPreviewOperation {
  sessionId: string;
  previewId: string | undefined;
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
}
interface Capability {
  previewId: string;
  origin: string;
  expiresAt: number;
  deviceValid(): boolean;
}
interface TrackedConnection {
  previewId: string;
  deviceValid(): boolean;
}
export interface PreviewDeps {
  daemonPort(): number;
  isSessionLive(sessionId: string): boolean;
  record(sessionId: string, preview: PreviewInfo): void;
  recordClosed(sessionId: string, previewId: string, reason: PreviewCloseReason): void;
  allowedTailscaleLogins: readonly string[];
  corsOrigins: readonly string[];
  timeoutMs?: number;
  warn?(message: string): void;
}

function textHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The caller's origin is the paired daemon's own address, not a model-supplied URL. */
export function previewOrigin(mainOrigin: string, daemonPort: number): string {
  let url: URL;
  try { url = new URL(mainOrigin); } catch { throw new ApiError(400, 'invalid_origin', 'invalid daemon origin'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ApiError(400, 'invalid_origin', 'invalid daemon origin');
  }
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    url.port = String(previewLocalPort(daemonPort));
    // The isolated listener is deliberately IPv4-only, independent of the daemon's loopback family.
    if (url.hostname === '[::1]') url.hostname = '127.0.0.1';
  } else if (url.protocol === 'https:' && url.hostname.endsWith('.ts.net')) {
    url.port = String(PREVIEW_HTTPS_PORT);
  } else {
    throw new ApiError(400, 'preview_transport_unavailable', 'use a private Tailscale HTTPS address or local loopback');
  }
  if (url.origin === new URL(mainOrigin).origin) {
    throw new ApiError(400, 'preview_origin_not_isolated', 'the preview must use a different origin');
  }
  return url.origin;
}

/** Ephemeral private previews: capabilities never contain device Bearers or session-agent credentials. */
export class Previews {
  private readonly entries = new Map<string, Preview>();
  private readonly tickets = new Map<string, Capability>();
  private readonly capabilities = new Map<string, Capability>();
  private readonly connections = new Map<Duplex, TrackedConnection>();
  private readonly sockets = new Set<Duplex>();
  private readonly hostAllowed: (headers: HostHeaders) => boolean;
  private readonly logins: Set<string>;
  private server: Server | undefined;
  private starting: Promise<void> | undefined;
  private revalidator: NodeJS.Timeout | undefined;
  private creating = 0;
  private readonly creatingBySession = new Map<string, number>();
  private readonly pending = new Set<PendingPreviewOperation>();
  private closed = false;

  constructor(private readonly deps: PreviewDeps) {
    this.hostAllowed = createHostCheck(deps.corsOrigins);
    this.logins = new Set(deps.allowedTailscaleLogins);
  }

  async create(sessionId: string, input: PreviewInput, signal?: AbortSignal): Promise<PreviewInfo> {
    this.assertLive(sessionId);
    const daemonPort = this.deps.daemonPort();
    if (input.port === daemonPort || input.port === previewLocalPort(daemonPort)) {
      throw new ApiError(400, 'preview_target_forbidden', 'cannot preview Nanachi itself');
    }
    let sessionPreviews = this.creatingBySession.get(sessionId) ?? 0;
    for (const entry of this.entries.values()) if (entry.sessionId === sessionId) sessionPreviews += 1;
    if (this.entries.size + this.creating >= MAX_PREVIEWS || sessionPreviews >= MAX_SESSION_PREVIEWS) {
      throw new ApiError(429, 'too_many_previews', 'close an existing preview first');
    }
    this.creating += 1;
    this.creatingBySession.set(sessionId, (this.creatingBySession.get(sessionId) ?? 0) + 1);
    const operation = this.beginOperation(sessionId, undefined, signal);
    try {
      this.assertPending(operation);
      const path = input.path ?? '/';
      const available = await probePreview(input.port, path, operation.controller.signal);
      this.assertPending(operation);
      if (!available) {
        throw new ApiError(502, 'preview_target_unavailable', 'start the HTTP server on IPv4 loopback before opening a preview');
      }
      this.assertLive(sessionId);
      const info: PreviewInfo = {
        previewId: randomUUID(), port: input.port, title: input.title ?? `localhost:${input.port}`,
        path, expiresAt: Date.now() + (this.deps.timeoutMs ?? PREVIEW_TIMEOUT_MS),
      };
      const timer = setTimeout(() => this.revokeSafely(info.previewId, 'expired'), Math.max(0, info.expiresAt - Date.now()));
      timer.unref();
      this.entries.set(info.previewId, { sessionId, info, timer });
      try {
        this.deps.record(sessionId, info);
        this.assertPending(operation);
      } catch (error) {
        clearTimeout(timer);
        this.entries.delete(info.previewId);
        throw error;
      }
      return info;
    } finally {
      this.creating -= 1;
      const creating = (this.creatingBySession.get(sessionId) ?? 1) - 1;
      if (creating === 0) this.creatingBySession.delete(sessionId);
      else this.creatingBySession.set(sessionId, creating);
      operation.finish();
    }
  }

  async open(
    sessionId: string, previewId: string, mainOrigin: string, deviceValid: () => boolean, signal?: AbortSignal,
  ): Promise<PreviewOpenResponse> {
    let entry = this.requireEntry(sessionId, previewId);
    const origin = previewOrigin(mainOrigin, this.deps.daemonPort());
    if (!deviceValid()) throw new ApiError(401, 'unauthorized', 'device is no longer authorized');
    const operation = this.beginOperation(sessionId, previewId, signal);
    try {
      this.assertPending(operation);
      await this.ensureGateway();
      this.assertPending(operation);
      const available = await probePreview(entry.info.port, entry.info.path, operation.controller.signal);
      this.assertPending(operation);
      if (!available) {
        throw new ApiError(502, 'preview_target_unavailable', 'the local preview server is unavailable');
      }
      entry = this.requireEntry(sessionId, previewId);
      if (!deviceValid()) throw new ApiError(401, 'unauthorized', 'device is no longer authorized');
      this.prune();
      this.assertPending(operation);
      if (this.tickets.size >= MAX_CAPABILITIES) throw new ApiError(429, 'too_many_preview_links', 'too many pending preview links');
      const ticket = randomBytes(32).toString('base64url');
      const expiresAt = Math.min(entry.info.expiresAt, Date.now() + TICKET_TIMEOUT_MS);
      this.tickets.set(ticket, { previewId, origin, expiresAt, deviceValid });
      return { url: `${origin}${PREVIEW_OPEN_PATH}#${ticket}`, expiresAt };
    } finally {
      operation.finish();
    }
  }

  closePreview(sessionId: string, previewId: string): void {
    this.requireEntry(sessionId, previewId);
    this.revoke(previewId, 'closed');
  }

  revokeSession(sessionId: string): void {
    for (const operation of this.pending) {
      if (operation.sessionId === sessionId) {
        operation.controller.abort(new ApiError(409, 'session_ended', 'the agent session has ended'));
      }
    }
    for (const [previewId, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.revokeSafely(previewId, 'session_ended');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.pending];
    for (const operation of pending) operation.controller.abort(new ApiError(409, 'session_ended', 'daemon is shutting down'));
    if (this.revalidator !== undefined) clearInterval(this.revalidator);
    for (const previewId of this.entries.keys()) this.revokeSafely(previewId, 'session_ended');
    this.tickets.clear();
    this.capabilities.clear();
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(pending.map((operation) => operation.done));
    const starting = this.starting;
    if (starting !== undefined) await starting.catch(() => undefined);
    const server = this.server;
    if (server !== undefined) {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  }

  private beginOperation(sessionId: string, previewId: string | undefined, signal?: AbortSignal): PendingPreviewOperation {
    const controller = new AbortController();
    const disconnected = (): void => {
      controller.abort(new ApiError(409, 'preview_not_available', 'preview request was disconnected'));
    };
    let settled!: () => void;
    const done = new Promise<void>((resolve) => { settled = resolve; });
    const operation: PendingPreviewOperation = {
      sessionId, previewId, controller, done,
      finish: () => {
        signal?.removeEventListener('abort', disconnected);
        this.pending.delete(operation);
        settled();
      },
    };
    this.pending.add(operation);
    signal?.addEventListener('abort', disconnected, { once: true });
    if (signal?.aborted) disconnected();
    return operation;
  }

  private assertPending(operation: PendingPreviewOperation): void {
    if (operation.controller.signal.aborted) throw operation.controller.signal.reason;
  }

  private assertLive(sessionId: string): void {
    if (this.closed || !this.deps.isSessionLive(sessionId)) throw new ApiError(409, 'session_ended', 'the agent session has ended');
  }

  private requireEntry(sessionId: string, previewId: string): Preview {
    const entry = this.entries.get(previewId);
    if (entry === undefined || entry.sessionId !== sessionId) throw new ApiError(409, 'preview_not_available', 'preview is no longer available');
    this.assertLive(sessionId);
    if (Date.now() >= entry.info.expiresAt) {
      this.revokeSafely(previewId, 'expired');
      throw new ApiError(410, 'preview_expired', 'preview has expired');
    }
    return entry;
  }

  private revoke(previewId: string, reason: PreviewCloseReason): void {
    const entry = this.entries.get(previewId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.entries.delete(previewId);
    const error = reason === 'expired'
      ? new ApiError(410, 'preview_expired', 'preview has expired')
      : reason === 'session_ended'
        ? new ApiError(409, 'session_ended', 'the agent session has ended')
        : new ApiError(409, 'preview_not_available', 'preview is no longer available');
    for (const operation of this.pending) {
      if (operation.previewId === previewId) operation.controller.abort(error);
    }
    for (const [token, capability] of this.tickets) if (capability.previewId === previewId) this.tickets.delete(token);
    for (const [token, capability] of this.capabilities) if (capability.previewId === previewId) this.capabilities.delete(token);
    for (const [socket, connection] of this.connections) if (connection.previewId === previewId) socket.destroy();
    this.deps.recordClosed(entry.sessionId, previewId, reason);
  }

  private revokeSafely(previewId: string, reason: PreviewCloseReason): void {
    try { this.revoke(previewId, reason); } catch { this.deps.warn?.('Failed to record a closed preview; its access has been revoked.'); }
  }

  private prune(): void {
    const now = Date.now();
    for (const [ticket, capability] of this.tickets) if (now >= capability.expiresAt || !capability.deviceValid()) this.tickets.delete(ticket);
    for (const [token, capability] of this.capabilities) if (!this.valid(capability)) this.capabilities.delete(token);
    for (const [socket, connection] of this.connections) {
      const entry = this.entries.get(connection.previewId);
      if (entry === undefined || now >= entry.info.expiresAt || !this.deps.isSessionLive(entry.sessionId) || !connection.deviceValid()) socket.destroy();
    }
  }

  private valid(capability: Capability): boolean {
    const entry = this.entries.get(capability.previewId);
    return !this.closed && entry !== undefined && Date.now() < capability.expiresAt
      && Date.now() < entry.info.expiresAt && this.deps.isSessionLive(entry.sessionId) && capability.deviceValid();
  }

  private async ensureGateway(): Promise<void> {
    if (this.closed) throw new ApiError(409, 'session_ended', 'daemon is shutting down');
    if (this.starting !== undefined) return this.starting;
    if (this.server?.listening) return;
    const server = createServer((request, reply) => {
      void this.handle(request, reply).catch(() => {
        if (reply.headersSent) reply.destroy();
        else this.reject(reply, 500, 'The preview could not be served.');
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => { this.sockets.delete(socket); this.connections.delete(socket); });
    });
    server.on('upgrade', (request, socket, head) => {
      const capability = this.authorizeGateway(request);
      const entry = capability === undefined ? undefined : this.entries.get(capability.previewId);
      if (capability === undefined || entry === undefined || request.headers.upgrade?.toLowerCase() !== 'websocket') {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.track(socket, capability);
      proxyPreviewUpgrade(request, socket, head, {
        port: entry.info.port, origin: capability.origin, track: (remote) => this.track(remote, capability),
      });
    });
    this.server = server;
    this.starting = new Promise<void>((resolve, reject) => {
      const failed = (): void => {
        this.server = undefined;
        reject(new ApiError(503, 'preview_gateway_unavailable', 'the adjacent loopback preview port is unavailable'));
      };
      server.once('error', failed);
      server.listen(previewLocalPort(this.deps.daemonPort()), '127.0.0.1', () => {
        server.off('error', failed);
        server.on('error', () => this.deps.warn?.('The loopback preview listener failed.'));
        if (this.closed) { server.close(); resolve(); return; }
        this.revalidator = setInterval(() => this.prune(), REVALIDATE_MS);
        this.revalidator.unref();
        resolve();
      });
    });
    try { await this.starting; } finally { this.starting = undefined; }
  }

  private originOf(request: IncomingMessage): string | undefined {
    const host = textHeader(request.headers.host);
    const forwardedHost = textHeader(request.headers['x-forwarded-host']);
    if (!isLoopbackAddress(request.socket.remoteAddress) || !this.hostAllowed({ host, forwardedHost })) return undefined;
    if (this.logins.size !== 0) {
      const login = trustedTailscaleLogin(request.socket.remoteAddress, request.headers['tailscale-user-login']);
      if (login === undefined || !this.logins.has(login)) return undefined;
    }
    const forwardedProto = textHeader(request.headers['x-forwarded-proto']);
    if (forwardedHost !== undefined || forwardedProto !== undefined) {
      if (forwardedHost === undefined || forwardedProto !== 'https' || forwardedHost.includes(',')) return undefined;
      try {
        const url = new URL(`https://${forwardedHost}`);
        return url.hostname.endsWith('.ts.net') && url.port === String(PREVIEW_HTTPS_PORT) ? url.origin : undefined;
      } catch { return undefined; }
    }
    try {
      const url = new URL(`http://${host}`);
      return ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === String(previewLocalPort(this.deps.daemonPort())) ? url.origin : undefined;
    } catch { return undefined; }
  }

  private authorizeGateway(request: IncomingMessage): Capability | undefined {
    const origin = this.originOf(request);
    if (origin === undefined) return undefined;
    const requestOrigin = textHeader(request.headers.origin);
    if (requestOrigin !== undefined && requestOrigin !== origin) return undefined;
    const cookieName = origin.startsWith('https:') ? SECURE_PREVIEW_COOKIE : PREVIEW_COOKIE;
    const cookie = request.headers.cookie?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`));
    const token = cookie?.slice(cookieName.length + 1);
    const capability = token === undefined ? undefined : this.capabilities.get(token);
    return capability !== undefined && capability.origin === origin && this.valid(capability) ? capability : undefined;
  }

  private track(socket: Duplex, capability: Capability): void {
    const existing = this.connections.get(socket);
    if (existing !== undefined) {
      existing.previewId = capability.previewId;
      existing.deviceValid = capability.deviceValid;
    } else {
      this.connections.set(socket, { previewId: capability.previewId, deviceValid: capability.deviceValid });
      socket.once('close', () => this.connections.delete(socket));
    }
  }

  private reject(reply: ServerResponse, status: number, text: string): void {
    reply.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    reply.end(text);
  }

  private async handle(request: IncomingMessage, reply: ServerResponse): Promise<void> {
    const origin = this.originOf(request);
    if (origin === undefined) { this.reject(reply, 403, 'Preview access is not allowed.'); return; }
    // Project service workers must never intercept the trusted ticket bootstrap on this shared preview origin.
    if (request.headers['service-worker'] !== undefined || request.headers['sec-fetch-dest'] === 'serviceworker') {
      this.reject(reply, 403, 'Service workers are not available on the shared preview origin.'); return;
    }
    const path = request.url?.split('?', 1)[0];
    if (path === PREVIEW_OPEN_PATH && request.method === 'GET') {
      reply.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': PREVIEW_BOOTSTRAP_CSP,
        'Cross-Origin-Opener-Policy': 'same-origin',
      });
      reply.end(PREVIEW_BOOTSTRAP_HTML);
      return;
    }
    if (path === PREVIEW_REDEEM_PATH && request.method === 'POST') {
      if (request.headers.origin !== origin || request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
        this.reject(reply, 403, 'Preview access is not allowed.'); return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > 256) { this.reject(reply, 413, 'Invalid preview link.'); return; }
        chunks.push(bytes);
      }
      let ticket: unknown;
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body === 'object' && body !== null && 'ticket' in body) ticket = body.ticket;
      } catch { /* Invalid JSON is an invalid link, never a proxy request. */ }
      const capability = typeof ticket === 'string' ? this.tickets.get(ticket) : undefined;
      if (capability === undefined || capability.origin !== origin || !this.valid(capability)) {
        this.reject(reply, 401, 'This preview link is expired or no longer authorized.'); return;
      }
      this.prune();
      if (this.capabilities.size >= MAX_CAPABILITIES) { this.reject(reply, 429, 'Too many open previews.'); return; }
      this.tickets.delete(String(ticket));
      const entry = this.entries.get(capability.previewId);
      if (entry === undefined) { this.reject(reply, 410, 'This preview has ended.'); return; }
      const token = randomBytes(32).toString('base64url');
      this.capabilities.set(token, { ...capability, expiresAt: entry.info.expiresAt });
      const secure = origin.startsWith('https:');
      reply.writeHead(200, {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Set-Cookie': `${secure ? SECURE_PREVIEW_COOKIE : PREVIEW_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.floor((entry.info.expiresAt - Date.now()) / 1000))}${secure ? '; Secure' : ''}`,
      });
      reply.end(JSON.stringify({ path: entry.info.path }));
      return;
    }
    if (path?.startsWith('/__nanachi_preview/')) { this.reject(reply, 404, 'Not found.'); return; }
    const capability = this.authorizeGateway(request);
    const entry = capability === undefined ? undefined : this.entries.get(capability.previewId);
    if (entry === undefined || capability === undefined) { this.reject(reply, 401, 'Return to Nanachi and open the preview again.'); return; }
    this.track(request.socket, capability);
    proxyPreviewHttp(request, reply, { port: entry.info.port, origin: capability.origin, track: (socket) => this.track(socket, capability) });
  }
}
