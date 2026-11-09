import { z } from 'zod';
import { WhisperLanguageSchema } from './whisper.js';

export const TranscriptionProviderSchema = z.enum(['whisper', 'openai', 'groq', 'custom']);
export type TranscriptionProvider = z.infer<typeof TranscriptionProviderSchema>;
/** The existing verified whisper.cpp Base Q5_1 installation remains the default. */
export const TranscriptionSettingsSchema = z.object({
  provider: TranscriptionProviderSchema.default('whisper'),
  model: z.string().max(500).default('ggml-base-q5_1.bin'),
  baseUrl: z.string().max(2000).default(''),
  timeoutMs: z.number().int().min(5000).max(180000).default(90000),
}).strict();
export type TranscriptionSettings = z.infer<typeof TranscriptionSettingsSchema>;
export const TranscriptionSettingsResponseSchema = TranscriptionSettingsSchema.extend({ apiKeyConfigured: z.boolean() });
export type TranscriptionSettingsResponse = z.infer<typeof TranscriptionSettingsResponseSchema>;
export const UpdateTranscriptionSettingsSchema = TranscriptionSettingsSchema.extend({
  apiKey: z.string().max(8000).optional(),
  removeApiKey: z.boolean().optional(),
});
export type UpdateTranscriptionSettings = z.infer<typeof UpdateTranscriptionSettingsSchema>;
export const TranscriptionStatusSchema = z.object({
  provider: TranscriptionProviderSchema,
  model: z.string().max(500),
  state: z.enum(['ready', 'not_ready', 'configuration_required', 'busy', 'unsupported']),
});
export type TranscriptionStatus = z.infer<typeof TranscriptionStatusSchema>;
export const TranscriptionModelSchema = z.object({
  id: z.string().min(1).max(500).refine((value) => !/[\s\u0000-\u001f\u007f]/u.test(value), 'Model identifiers must not contain whitespace or control characters.'),
  name: z.string().min(1).max(500),
  provider: TranscriptionProviderSchema,
  deprecated: z.boolean().optional(),
});
export type TranscriptionModel = z.infer<typeof TranscriptionModelSchema>;
export const TranscriptionModelsResponseSchema = z.object({
  models: z.array(TranscriptionModelSchema).max(1000),
  manual: z.boolean(),
});
export type TranscriptionModelsResponse = z.infer<typeof TranscriptionModelsResponseSchema>;
export const TranscriptionResultSchema = z.object({ text: z.string().trim().min(1).max(100000) });
export type TranscriptionResult = z.infer<typeof TranscriptionResultSchema>;
export const TranscriptionLanguageSchema = WhisperLanguageSchema;
export type TranscriptionLanguage = z.infer<typeof TranscriptionLanguageSchema>;
