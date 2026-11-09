import { z } from 'zod';
import { ShellIdSchema } from './shell.js';

export const SCHEDULE_OUTPUT_MAX = 65_536;
export const SCHEDULE_HISTORY_MAX = 100;
export const SCHEDULES_PER_WORKSPACE_MAX = 100;

const IdSchema = z.string().min(1).max(200);
const TimestampSchema = z.number().int().nonnegative();
export const ScheduleTaskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    agentId: IdSchema,
    accountId: IdSchema.default('default'),
    model: z.string().max(500).default(''),
    prompt: z.string().trim().min(1).max(100_000),
  }).strict(),
  z.object({
    kind: z.literal('command'),
    shell: ShellIdSchema,
    command: z.string().trim().min(1).max(10_000),
  }).strict(),
]);
export type ScheduleTask = z.infer<typeof ScheduleTaskSchema>;

export const ScheduleTimingSchema = z.object({
  cronExpression: z.string().trim().min(1).max(256),
  timeZone: z.string().trim().min(1).max(100),
}).strict();
export type ScheduleTiming = z.infer<typeof ScheduleTimingSchema>;
export const ScheduleInputSchema = ScheduleTimingSchema.extend({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(1_000).max(86_400_000).default(600_000),
  task: ScheduleTaskSchema,
});
export type ScheduleInput = z.infer<typeof ScheduleInputSchema>;
export const ScheduleSchema = ScheduleInputSchema.extend({
  id: IdSchema,
  workspaceId: IdSchema,
  nextRunAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Schedule = z.infer<typeof ScheduleSchema>;
export const SchedulesResponseSchema = z.object({ schedules: z.array(ScheduleSchema).max(SCHEDULES_PER_WORKSPACE_MAX) });
export type SchedulesResponse = z.infer<typeof SchedulesResponseSchema>;
export const SchedulePreviewResponseSchema = z.object({ nextRuns: z.array(TimestampSchema).length(5) });
export type SchedulePreviewResponse = z.infer<typeof SchedulePreviewResponseSchema>;

export const ScheduleRunStatusSchema = z.enum([
  'running', 'awaiting_permission', 'succeeded', 'failed', 'cancelled', 'timed_out', 'missed', 'interrupted',
]);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatusSchema>;
export const ScheduleRunSchema = z.object({
  id: IdSchema,
  scheduleId: IdSchema,
  workspaceId: IdSchema,
  scheduleName: z.string().min(1).max(100),
  task: ScheduleTaskSchema,
  trigger: z.enum(['scheduled', 'manual']),
  status: ScheduleRunStatusSchema,
  scheduledAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  finishedAt: TimestampSchema.nullable(),
  sessionId: IdSchema.nullable(),
  exitCode: z.number().int().nullable(),
  error: z.string().max(2_000).nullable(),
  output: z.string().max(SCHEDULE_OUTPUT_MAX),
  outputTruncated: z.boolean(),
});
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;
export const ScheduleRunsResponseSchema = z.object({ runs: z.array(ScheduleRunSchema).max(SCHEDULE_HISTORY_MAX) });
export type ScheduleRunsResponse = z.infer<typeof ScheduleRunsResponseSchema>;
export const ScheduleModelsResponseSchema = z.object({
  models: z.array(z.object({ id: z.string().min(1).max(500), name: z.string().min(1).max(500) })).max(2_000),
  currentModel: z.string().max(500).nullable(),
  supported: z.boolean(),
});
export type ScheduleModelsResponse = z.infer<typeof ScheduleModelsResponseSchema>;
