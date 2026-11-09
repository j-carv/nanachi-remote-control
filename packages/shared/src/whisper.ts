import { z } from 'zod';

export const WHISPER_SAMPLE_RATE = 16_000;
export const WHISPER_MAX_SECONDS = 60;
export const WHISPER_WAV_HEADER_BYTES = 44;
export const WHISPER_MAX_WAV_BYTES = WHISPER_WAV_HEADER_BYTES + WHISPER_SAMPLE_RATE * WHISPER_MAX_SECONDS * 2;

export const WhisperLanguageSchema = z.enum(['pt', 'en', 'es']);
export type WhisperLanguage = z.infer<typeof WhisperLanguageSchema>;

export const WhisperStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('disabled') }),
  z.object({ state: z.literal('installing'), progress: z.number().min(0).max(100) }),
  z.object({ state: z.literal('ready') }),
  z.object({ state: z.literal('removing') }),
  z.object({ state: z.literal('install_failed') }),
  z.object({ state: z.literal('remove_failed') }),
  z.object({ state: z.literal('unsupported') }),
]);
export type WhisperStatus = z.infer<typeof WhisperStatusSchema>;

export const WhisperTranscriptSchema = z.object({ text: z.string().min(1).max(100_000) });
export type WhisperTranscript = z.infer<typeof WhisperTranscriptSchema>;
