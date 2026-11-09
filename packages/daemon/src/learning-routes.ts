import { UpdateLearningSettingsSchema, type AgentConfig } from '@nanachi/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './api-error.js';
import type { LearningAgents } from './learning-agents.js';
import { LearningError, learningErrorMessage } from './learning-errors.js';
import type { LearningService } from './learning-service.js';
import type { LearningSettingsStore } from './learning-settings.js';

interface LearningRouteDeps {
  agents: Readonly<Record<string, AgentConfig>>;
  settings: LearningSettingsStore;
  service: LearningService;
  reviewers: Pick<LearningAgents, 'assertSupported'>;
  requireDevice(request: FastifyRequest, reply: FastifyReply): Promise<unknown>;
}

export async function registerLearningRoutes(app: FastifyInstance, deps: LearningRouteDeps): Promise<void> {
  const catalogs = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const controller of catalogs) controller.abort();
    catalogs.clear();
  });
  app.get('/api/learning/settings', { onRequest: deps.requireDevice }, async () => deps.settings.get());
  app.put('/api/learning/settings', { onRequest: deps.requireDevice }, async (request) => {
    const parsed = UpdateLearningSettingsSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Invalid learning settings');
    const input = parsed.data;
    if (input.enabledAgents.some((id) => deps.agents[id]?.kind !== 'acp')) {
      throw new ApiError(400, 'invalid_request', 'Learning opt-ins require configured ACP agents');
    }
    if (input.reviewer.source === 'agent') {
      try {
        deps.reviewers.assertSupported(input.reviewer.agentId);
      } catch (error) {
        throw new ApiError(400, 'reviewer_unsupported', 'Reviewer cannot run inference without tools', { message: learningErrorMessage(error) });
      }
    }
    const saved = deps.settings.update(input);
    deps.service.reconfigure();
    return saved;
  });
  app.get('/api/learning/models', { onRequest: deps.requireDevice }, async (request, reply) => {
    const controller = new AbortController();
    catalogs.add(controller);
    const cancel = (): void => controller.abort();
    const timer = setTimeout(cancel, 30_000);
    request.raw.once('aborted', cancel);
    reply.raw.once('close', cancel);
    try {
      return await deps.service.models(controller.signal);
    } catch (error) {
      const message = controller.signal.aborted
        ? 'Model discovery was cancelled or exceeded its time limit.'
        : learningErrorMessage(error instanceof LearningError ? error : undefined);
      return { models: [], errors: [{ source: 'catalog', message }] };
    } finally {
      clearTimeout(timer);
      request.raw.off('aborted', cancel);
      reply.raw.off('close', cancel);
      catalogs.delete(controller);
    }
  });
}
