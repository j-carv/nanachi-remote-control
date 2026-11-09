import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from './api-error.js';
import type { DeviceGuard } from './file-routes.js';
import type { ScheduleService } from './schedule-service.js';

interface ScheduleParams { workspaceId: string; scheduleId: string }
interface RunParams extends ScheduleParams { runId: string }

const ModelsQuerySchema = z.object({
  agentId: z.string().min(1).max(200),
  accountId: z.string().min(1).max(200).default('default'),
}).strict();
const EmptyObjectSchema = z.object({}).strict();

export async function registerScheduleRoutes(
  app: FastifyInstance,
  service: ScheduleService,
  requireDevice: DeviceGuard,
): Promise<void> {
  await app.register(async (api) => {
    api.addHook('onRequest', requireDevice);
    api.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    api.addHook('preValidation', async (request) => {
      const path = request.routeOptions.url ?? '';
      if (!path.endsWith('/models') && !EmptyObjectSchema.safeParse(request.query).success) {
        throw new ApiError(400, 'invalid_request', 'unexpected schedule query parameters');
      }
      if (request.method === 'POST' && (path.endsWith('/run') || path.endsWith('/cancel'))
        && request.body !== undefined && !EmptyObjectSchema.safeParse(request.body).success) {
        throw new ApiError(400, 'invalid_request', 'unexpected schedule action body');
      }
    });

    api.get<{ Params: { workspaceId: string } }>('/api/workspaces/:workspaceId/schedules', async (request) => {
      return { schedules: service.list(request.params.workspaceId) };
    });
    api.post<{ Params: { workspaceId: string } }>('/api/workspaces/:workspaceId/schedules', async (request, reply) => {
      return reply.code(201).send(service.create(request.params.workspaceId, request.body));
    });
    api.post<{ Params: { workspaceId: string } }>('/api/workspaces/:workspaceId/schedules/preview', async (request) => {
      return { nextRuns: service.preview(request.params.workspaceId, request.body) };
    });
    api.get<{ Params: { workspaceId: string } }>('/api/workspaces/:workspaceId/schedules/models', async (request, reply) => {
      const query = ModelsQuerySchema.safeParse(request.query);
      if (!query.success) throw new ApiError(400, 'invalid_request', 'invalid model catalog query');
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      request.raw.once('aborted', cancel);
      reply.raw.once('close', cancel);
      if (request.raw.aborted || reply.raw.destroyed) cancel();
      try {
        return await service.models(request.params.workspaceId, query.data.agentId, query.data.accountId, controller.signal);
      } finally {
        request.raw.off('aborted', cancel);
        reply.raw.off('close', cancel);
      }
    });
    api.put<{ Params: ScheduleParams }>('/api/workspaces/:workspaceId/schedules/:scheduleId', async (request) => {
      return service.update(request.params.workspaceId, request.params.scheduleId, request.body);
    });
    api.delete<{ Params: ScheduleParams }>('/api/workspaces/:workspaceId/schedules/:scheduleId', async (request, reply) => {
      await service.remove(request.params.workspaceId, request.params.scheduleId);
      return reply.code(204).send();
    });
    api.post<{ Params: ScheduleParams }>('/api/workspaces/:workspaceId/schedules/:scheduleId/run', async (request, reply) => {
      return reply.code(202).send(service.runNow(request.params.workspaceId, request.params.scheduleId));
    });
    api.get<{ Params: ScheduleParams }>('/api/workspaces/:workspaceId/schedules/:scheduleId/runs', async (request) => {
      return { runs: service.runs(request.params.workspaceId, request.params.scheduleId) };
    });
    api.get<{ Params: RunParams }>('/api/workspaces/:workspaceId/schedules/:scheduleId/runs/:runId', async (request) => {
      return service.run(request.params.workspaceId, request.params.scheduleId, request.params.runId);
    });
    api.post<{ Params: RunParams }>('/api/workspaces/:workspaceId/schedules/:scheduleId/runs/:runId/cancel', async (request) => {
      return service.cancel(request.params.workspaceId, request.params.scheduleId, request.params.runId);
    });
  });
}
