import { RequestFileRequestSchema, RespondFileRequestSchema } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceGuard } from './file-routes.js';
import { findSessionById } from './repository.js';
import type { SessionManager } from './session-manager.js';
import { isLoopbackAddress } from './tailscale-login.js';

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export async function registerFileRequestRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database; sessions: SessionManager; requireDevice: DeviceGuard },
): Promise<void> {
  const { db, sessions, requireDevice } = deps;
  await app.register(async (agent) => {
    agent.addHook('onRequest', async (request, reply) => {
      if (!isLoopbackAddress(request.ip)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      for (const name in request.headers) {
        if (name === 'forwarded' || name.startsWith('x-forwarded-') || name.startsWith('tailscale-')) {
          return reply.code(403).send({ error: 'forbidden' });
        }
      }
      const sessionId = header(request, 'x-nanachi-session');
      if (sessionId === undefined || !sessions.verifyAgentToken(sessionId, header(request, 'x-nanachi-agent-token'))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!sessions.isLive(sessionId)) return reply.code(403).send({ error: 'session_not_live' });
      return undefined;
    });
    agent.post('/api/agent/file-requests', { bodyLimit: 32_768 }, async (request, reply) => {
      const parsed = RequestFileRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const disconnected = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableFinished) disconnected.abort();
      };
      // The response connection, not completion of the uploaded JSON body, owns the MCP waiter.
      reply.raw.once('close', onClose);
      if (reply.raw.destroyed) disconnected.abort();
      try {
        return await sessions.requestFile(header(request, 'x-nanachi-session') ?? '', parsed.data, disconnected.signal);
      } finally {
        reply.raw.off('close', onClose);
      }
    });
  });
  await app.register(async (device) => {
    device.addHook('onRequest', requireDevice);
    device.post<{ Params: { id: string; requestId: string } }>(
      '/api/sessions/:id/file-requests/:requestId/respond',
      async (request, reply) => {
        const parsed = RespondFileRequestSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
        if (findSessionById(db, request.params.id) === undefined) return reply.code(404).send({ error: 'not_found' });
        return sessions.respondFileRequest(request.params.id, request.params.requestId, parsed.data.fileId);
      },
    );
  });
}
