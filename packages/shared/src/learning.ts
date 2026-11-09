import { z } from 'zod';

export const LearningReviewerSchema = z.object({
  source: z.enum(['same', 'agent', 'openrouter', 'openai', 'ollama']).default('same'),
  agentId: z.string().max(200).default(''),
  model: z.string().max(500).default(''),
  baseUrl: z.string().max(2000).default(''),
}).strict();
export type LearningReviewer = z.infer<typeof LearningReviewerSchema>;

/** Disabled until the owner explicitly opts in to model usage and memory retention. */
export const LearningSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  enabledAgents: z.array(z.string().min(1).max(200)).max(100).default([]),
  reviewer: LearningReviewerSchema.default({ source: 'same', agentId: '', model: '', baseUrl: '' }),
  approvalRequired: z.boolean().default(false),
  intervalTurns: z.number().int().min(1).max(100).default(3),
  maxInputChars: z.number().int().min(2000).max(100000).default(24000),
  maxOutputTokens: z.number().int().min(256).max(8192).default(2048),
  timeoutMs: z.number().int().min(5000).max(180000).default(60000),
}).strict();
export type LearningSettings = z.infer<typeof LearningSettingsSchema>;
export const LearningSettingsResponseSchema = LearningSettingsSchema.extend({ apiKeyConfigured: z.boolean() });
export type LearningSettingsResponse = z.infer<typeof LearningSettingsResponseSchema>;
export const UpdateLearningSettingsSchema = LearningSettingsSchema.extend({
  apiKey: z.string().max(8000).optional(),
  removeApiKey: z.boolean().optional(),
});
export type UpdateLearningSettings = z.infer<typeof UpdateLearningSettingsSchema>;

export const LearningModelSchema = z.object({
  id: z.string().min(1).max(500),
  label: z.string().min(1).max(500),
  provider: z.string().max(200),
  source: z.enum(['agent', 'openrouter', 'openai', 'ollama']),
  agentId: z.string().max(200).optional(),
});
export type LearningModel = z.infer<typeof LearningModelSchema>;
export const LearningModelsResponseSchema = z.object({
  models: z.array(LearningModelSchema),
  errors: z.array(z.object({ source: z.string(), message: z.string().max(500) })),
});
export type LearningModelsResponse = z.infer<typeof LearningModelsResponseSchema>;

export const MemoryKindSchema = z.enum(['memory', 'skill']);
export const MemoryEntrySchema = z.object({
  id: z.uuid(),
  workspaceId: z.string().min(1),
  kind: MemoryKindSchema,
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(12000),
  status: z.enum(['active', 'pending', 'deleted']),
  version: z.number().int().positive(),
  sourceSessionId: z.string().nullable(),
  reviewId: z.uuid().nullable(),
  evidenceSeqs: z.array(z.number().int().positive()).max(30),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export const MemoryEntriesResponseSchema = z.object({ entries: z.array(MemoryEntrySchema) });
export const MemoryWriteSchema = z.object({
  id: z.uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  kind: MemoryKindSchema,
  title: MemoryEntrySchema.shape.title,
  content: MemoryEntrySchema.shape.content,
  evidenceSeqs: z.array(z.number().int().positive()).max(30).default([]),
}).strict().superRefine((value, context) => {
  if ((value.id === undefined) !== (value.expectedVersion === undefined)) {
    context.addIssue({ code: 'custom', message: 'Updates require both id and expectedVersion.' });
  }
});
export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;
export const MemoryToolInputSchema = z.object({
  action: z.enum(['search', 'read', 'save', 'forget']),
  query: z.string().max(1000).optional(),
  id: z.uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  title: MemoryEntrySchema.shape.title.optional(),
  content: MemoryEntrySchema.shape.content.optional(),
  evidenceSeqs: z.array(z.number().int().positive()).max(30).optional(),
}).strict().superRefine((value, context) => {
  if ((value.action === 'read' || value.action === 'forget') && value.id === undefined) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'This action requires an entry id.' });
  }
  if (value.action === 'forget' && value.expectedVersion === undefined) {
    context.addIssue({ code: 'custom', path: ['expectedVersion'], message: 'Forgetting requires the current version.' });
  }
  if (value.action === 'save') {
    if (value.title === undefined || value.content === undefined) {
      context.addIssue({ code: 'custom', message: 'Saving requires a title and content.' });
    }
    if ((value.id === undefined) !== (value.expectedVersion === undefined)) {
      context.addIssue({ code: 'custom', message: 'Updates require both id and expectedVersion.' });
    }
  }
});
export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

/** Reviewer output is data, never executable instructions or a message in the primary conversation. */
export const LearningReviewResultSchema = z.object({
  summary: z.string().trim().max(600),
  entries: z.array(MemoryWriteSchema).max(8),
}).strict();
export type LearningReviewResult = z.infer<typeof LearningReviewResultSchema>;
export const LearningNoticeShape = {
  reviewId: z.uuid(),
  status: z.enum(['applied', 'pending', 'failed', 'reverted', 'rejected']),
  summary: z.string().max(600),
  memoryCount: z.number().int().nonnegative(),
  skillCount: z.number().int().nonnegative(),
  entryIds: z.array(z.uuid()).max(8),
  sourceTurnSeq: z.number().int().positive(),
};
export const LearningNoticeSchema = z.object(LearningNoticeShape);
export type LearningNotice = z.infer<typeof LearningNoticeSchema>;
