import { AskUserRequestSchema, RespondUserQuestionRequestSchema } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceGuard } from './file-routes.js';
import { findSessionById } from './repository.js';
import type { SessionManager } from './session-manager.js';
import { isLoopbackAddress } from './tailscale-login.js';

const AGENT_PROXY_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login',
] as const;

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

export async function registerQuestionRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database; sessions: SessionManager; requireDevice: DeviceGuard },
): Promise<void> {
  const { db, sessions, requireDevice } = deps;
  await app.register(async (agent) => {
    agent.addHook('onRequest', async (request, reply) => {
      // Never grant device Bearers agent privileges, or accept calls arriving through a proxy.
      if (!isLoopbackAddress(request.ip) || AGENT_PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const sessionId = header(request, 'x-nanachi-session');
      // Token first: unauthenticated callers must not learn whether a session is alive.
      if (sessionId === undefined || !sessions.verifyAgentToken(sessionId, header(request, 'x-nanachi-agent-token'))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!sessions.isLive(sessionId)) return reply.code(403).send({ error: 'session_not_live' });
      return undefined;
    });
    agent.post('/api/agent/questions', { bodyLimit: 32_768 }, async (request, reply) => {
      const parsed = AskUserRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const disconnected = new AbortController();
      const onClose = (): void => {
        if (!reply.raw.writableFinished) disconnected.abort();
      };
      // IncomingMessage.close also fires when its request body ends: only the response socket owns this waiter.
      reply.raw.once('close', onClose);
      if (reply.raw.destroyed) disconnected.abort();
      try {
        return await sessions.askUser(header(request, 'x-nanachi-session') ?? '', parsed.data, disconnected.signal);
      } finally {
        reply.raw.off('close', onClose);
      }
    });
  });
  await app.register(async (device) => {
    device.addHook('onRequest', requireDevice);
    device.post<{ Params: { id: string; requestId: string } }>(
      '/api/sessions/:id/questions/:requestId/respond',
      async (request, reply) => {
        const parsed = RespondUserQuestionRequestSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
        if (findSessionById(db, request.params.id) === undefined) return reply.code(404).send({ error: 'not_found' });
        return sessions.respondUserQuestion(request.params.id, request.params.requestId, parsed.data.optionId);
      },
    );
  });
}
