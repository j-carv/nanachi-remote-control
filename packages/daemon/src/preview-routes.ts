import { PreviewInputSchema } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceGuard } from './file-routes.js';
import { findSessionById } from './repository.js';
import type { Previews } from './previews.js';
import type { SessionManager } from './session-manager.js';
import { isLoopbackAddress } from './tailscale-login.js';

const AGENT_PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login'] as const;

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export async function registerPreviewRoutes(app: FastifyInstance, deps: {
  db: Database.Database;
  sessions: SessionManager;
  previews: Previews;
  requireDevice: DeviceGuard;
  deviceValid(token: string | undefined): boolean;
}): Promise<void> {
  const { db, sessions, previews, requireDevice } = deps;
  await app.register(async (agent) => {
    agent.addHook('onRequest', async (request, reply) => {
      if (!isLoopbackAddress(request.ip) || AGENT_PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const sessionId = header(request, 'x-nanachi-session');
      if (sessionId === undefined || !sessions.verifyAgentToken(sessionId, header(request, 'x-nanachi-agent-token'))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!sessions.isLive(sessionId)) return reply.code(403).send({ error: 'session_not_live' });
      return undefined;
    });
    agent.post('/api/agent/previews', { bodyLimit: 8192 }, async (request, reply) => {
      const parsed = PreviewInputSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const disconnected = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableFinished) disconnected.abort();
      };
      reply.raw.once('close', onClose);
      if (reply.raw.destroyed) disconnected.abort();
      try {
        const preview = await previews.create(header(request, 'x-nanachi-session') ?? '', parsed.data, disconnected.signal);
        return reply.code(201).send(preview);
      } finally {
        reply.raw.off('close', onClose);
      }
    });
  });
  await app.register(async (device) => {
    device.addHook('onRequest', requireDevice);
    device.post<{ Params: { id: string; previewId: string } }>(
      '/api/sessions/:id/previews/:previewId/open',
      async (request, reply) => {
        if (findSessionById(db, request.params.id) === undefined) return reply.code(404).send({ error: 'not_found' });
        const host = header(request, 'x-forwarded-host') ?? header(request, 'host');
        const forwardedProto = header(request, 'x-forwarded-proto');
        const encrypted = 'encrypted' in request.socket && request.socket.encrypted === true;
        const protocol = forwardedProto ?? (encrypted ? 'https' : 'http');
        if (host === undefined || host.includes(',') || !['http', 'https'].includes(protocol)) {
          return reply.code(400).send({ error: 'invalid_origin' });
        }
        const token = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
        const disconnected = new AbortController();
        const onClose = (): void => {
          if (!reply.raw.writableFinished) disconnected.abort();
        };
        reply.raw.once('close', onClose);
        if (reply.raw.destroyed) disconnected.abort();
        try {
          return await previews.open(
            request.params.id, request.params.previewId, `${protocol}://${host}`, () => deps.deviceValid(token), disconnected.signal,
          );
        } finally {
          reply.raw.off('close', onClose);
        }
      },
    );
    device.delete<{ Params: { id: string; previewId: string } }>(
      '/api/sessions/:id/previews/:previewId',
      async (request, reply) => {
        if (findSessionById(db, request.params.id) === undefined) return reply.code(404).send({ error: 'not_found' });
        previews.closePreview(request.params.id, request.params.previewId);
        return { ok: true as const };
      },
    );
  });
}
