import {
  LearningNoticeSchema, MemoryKindSchema, MemoryToolInputSchema, MemoryWriteSchema,
  type LearningSettingsResponse, type LearningNotice,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from './api-error.js';
import type { DeviceGuard } from './file-routes.js';
import type { LearningMemory } from './learning-memory.js';
import { findSessionById, findWorkspaceById } from './repository.js';
import type { SessionManager } from './session-manager.js';

export interface LearningMemoryRouteDeps {
  db: Database.Database;
  sessions: Pick<SessionManager, 'isLive' | 'verifyAgentToken'>;
  memory: LearningMemory;
  requireDevice: DeviceGuard;
  settings: () => LearningSettingsResponse;
  mcpEnabled: (agentId: string) => boolean;
  recordNotice: (sessionId: string, notice: LearningNotice) => void;
}
const QuerySchema = z.object({ query: z.string().max(1000).optional(), kind: MemoryKindSchema.optional(), status: z.enum(['active', 'pending', 'deleted']).optional() }).strict();
const ForgetSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const AgentSchema = z.object({ kind: MemoryKindSchema, input: MemoryToolInputSchema }).strict();
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login'];
function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Device management is independent of opt-in; model access requires both learning and MCP opt-ins. */
export async function registerLearningMemoryRoutes(app: FastifyInstance, deps: LearningMemoryRouteDeps): Promise<void> {
  const { db, sessions, memory, requireDevice } = deps;
  await app.register(async (device) => {
    device.addHook('onRequest', requireDevice);
    device.get<{ Params: { id: string } }>('/api/workspaces/:id/memories', async (request) => {
      if (findWorkspaceById(db, request.params.id) === undefined) throw new ApiError(404, 'not_found', 'Workspace not found');
      const query = QuerySchema.safeParse(request.query);
      if (!query.success) throw new ApiError(400, 'invalid_request', 'Invalid memory search');
      const { query: text, kind, status } = query.data;
      return { entries: memory.list(request.params.id, { ...(text === undefined ? {} : { query: text }), ...(kind === undefined ? {} : { kind }), ...(status === undefined ? {} : { status }) }) };
    });
    device.post<{ Params: { id: string } }>('/api/workspaces/:id/memories', { bodyLimit: 60000 }, async (request) => {
      const write = MemoryWriteSchema.safeParse(request.body);
      if (!write.success) throw new ApiError(400, 'invalid_request', 'Invalid memory write');
      return { entries: [memory.save(request.params.id, write.data)] };
    });
    device.delete<{ Params: { id: string; entryId: string } }>('/api/workspaces/:id/memories/:entryId', async (request) => {
      const body = ForgetSchema.safeParse(request.body);
      if (!body.success) throw new ApiError(400, 'invalid_request', 'Invalid memory deletion');
      memory.forget(request.params.id, request.params.entryId, body.data.expectedVersion);
      return { entries: [] };
    });
    device.post<{ Params: { id: string; reviewId: string; action: string } }>('/api/workspaces/:id/learning/:reviewId/:action', async (request) => {
      const { id, reviewId, action } = request.params;
      if (action !== 'approve' && action !== 'reject' && action !== 'revert') throw new ApiError(400, 'invalid_request', 'Invalid review action');
      const review = db.prepare<[string, string], { session_id: string }>('SELECT session_id FROM learning_reviews WHERE workspace_id = ? AND id = ?').get(id, reviewId);
      const notice = memory.manageReview(id, reviewId, action);
      if (notice !== null && review !== undefined) deps.recordNotice(review.session_id, notice);
      return notice ?? { ok: true };
    });
  });
  await app.register(async (agent) => {
    agent.addHook('onRequest', async (request, reply) => {
      if (PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) return reply.code(403).send({ error: 'forbidden' });
      const sessionId = header(request, 'x-nanachi-session');
      if (sessionId === undefined || !sessions.verifyAgentToken(sessionId, header(request, 'x-nanachi-agent-token'))) return reply.code(401).send({ error: 'unauthorized' });
      if (!sessions.isLive(sessionId)) return reply.code(403).send({ error: 'session_not_live' });
      const session = findSessionById(db, sessionId);
      const settings = deps.settings();
      if (session === undefined || !settings.enabled || !settings.enabledAgents.includes(session.agent) || !deps.mcpEnabled(session.agent)) return reply.code(403).send({ error: 'learning_disabled' });
      return undefined;
    });
    agent.post('/api/agent/memory', { bodyLimit: 60000 }, async (request) => {
      const parsed = AgentSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Invalid memory tool input');
      const sessionId = header(request, 'x-nanachi-session') ?? '';
      const session = findSessionById(db, sessionId);
      if (session === undefined) throw new ApiError(404, 'not_found', 'Session not found');
      const { kind, input } = parsed.data;
      const workspaceId = session.workspaceId;
      if (input.action === 'search') return { entries: memory.list(workspaceId, { kind, status: 'active', ...(input.query === undefined ? {} : { query: input.query }) }) };
      if (input.action === 'read' || input.action === 'forget') {
        const entry = input.id === undefined ? undefined : memory.read(workspaceId, input.id);
        if (entry === undefined || entry.kind !== kind || entry.status !== 'active') throw new ApiError(404, 'not_found', 'Memory not found');
        if (input.action === 'read') return { entries: [entry] };
        if (input.expectedVersion === undefined) throw new ApiError(400, 'invalid_request', 'Memory version required');
        memory.forget(workspaceId, entry.id, input.expectedVersion);
        return { entries: [] };
      }
      const evidenceSeqs = input.evidenceSeqs ?? db.prepare<[string], { seq: number }>("SELECT seq FROM events WHERE session_id = ? AND kind = 'user_message' ORDER BY seq DESC LIMIT 1").all(sessionId).map((event) => event.seq);
      const write = MemoryWriteSchema.safeParse({ kind, title: input.title, content: input.content, evidenceSeqs, ...(input.id === undefined ? {} : { id: input.id }), ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }) });
      if (!write.success) throw new ApiError(400, 'invalid_request', 'Invalid memory write');
      const lastHistory = db.prepare<[], { seq: number }>('SELECT COALESCE(MAX(seq), 0) AS seq FROM learning_history').get()?.seq ?? 0;
      const entry = memory.save(workspaceId, write.data, { sessionId, pending: deps.settings().approvalRequired });
      const changed = db.prepare<[number, string], { found: number }>('SELECT 1 AS found FROM learning_history WHERE seq > ? AND entry_id = ? LIMIT 1').get(lastHistory, entry.id) !== undefined;
      if (changed && entry.reviewId !== null && (entry.status === 'pending' || entry.status === 'active')) {
        const review = db.prepare<[string, string, string], { summary: string; source_turn_seq: number }>('SELECT summary, source_turn_seq FROM learning_reviews WHERE workspace_id = ? AND id = ? AND session_id = ?').get(workspaceId, entry.reviewId, sessionId);
        if (review !== undefined) deps.recordNotice(sessionId, LearningNoticeSchema.parse({ reviewId: entry.reviewId, status: entry.status === 'active' ? 'applied' : 'pending', summary: review.summary, memoryCount: kind === 'memory' ? 1 : 0, skillCount: kind === 'skill' ? 1 : 0, entryIds: [entry.id], sourceTurnSeq: review.source_turn_seq }));
      }
      return { entries: [entry] };
    });
  });
}
