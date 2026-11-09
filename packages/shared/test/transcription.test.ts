import { describe, expect, it } from 'vitest';
import {
  TranscriptionLanguageSchema,
  TranscriptionModelSchema,
  TranscriptionResultSchema,
  TranscriptionSettingsResponseSchema,
  TranscriptionSettingsSchema,
  UpdateTranscriptionSettingsSchema,
} from '../src/index.js';

describe('transcription provider contract', () => {
  it('preserves the existing offline model when no provider has been selected', () => {
    const settings = TranscriptionSettingsSchema.parse({});
    expect(settings.provider).toBe('whisper');
    expect(settings.model).toBe('ggml-base-q5_1.bin');
    expect(settings.baseUrl).toBe('');
  });

  it('accepts owner key writes but rejects keys in public settings responses', () => {
    const settings = TranscriptionSettingsSchema.parse({ provider: 'custom', model: 'local-asr', baseUrl: 'http://127.0.0.1:8000/v1' });
    expect(UpdateTranscriptionSettingsSchema.safeParse({ ...settings, apiKey: 'synthetic-key' }).success).toBe(true);
    expect(TranscriptionSettingsResponseSchema.safeParse({ ...settings, apiKeyConfigured: true }).success).toBe(true);
    expect(TranscriptionSettingsResponseSchema.safeParse({ ...settings, apiKeyConfigured: true, apiKey: 'synthetic-key' }).success).toBe(false);
  });

  it('bounds deadlines and rejects unknown providers or unsafe catalog identifiers', () => {
    expect(UpdateTranscriptionSettingsSchema.safeParse({ timeoutMs: 0 }).success).toBe(false);
    expect(UpdateTranscriptionSettingsSchema.safeParse({ timeoutMs: 180001 }).success).toBe(false);
    expect(TranscriptionSettingsSchema.safeParse({ provider: 'arbitrary-shell-command' }).success).toBe(false);
    for (const id of ['local\nasr', 'local asr', 'local\tasr', '\u0000']) {
      expect(TranscriptionModelSchema.safeParse({ id, name: 'Synthetic model', provider: 'custom' }).success).toBe(false);
    }
    expect(TranscriptionModelSchema.safeParse({ id: 'organization/local-asr:v2', name: 'Synthetic model', provider: 'custom' }).success).toBe(true);
  });

  it('does not accept empty transcripts or unsupported dictation languages', () => {
    expect(TranscriptionResultSchema.safeParse({ text: '  ' }).success).toBe(false);
    expect(TranscriptionResultSchema.safeParse({ text: 'x'.repeat(100001) }).success).toBe(false);
    expect(TranscriptionResultSchema.parse({ text: '  Synthetic transcript.  ' })).toEqual({ text: 'Synthetic transcript.' });
    for (const language of ['pt', 'en', 'es']) expect(TranscriptionLanguageSchema.safeParse(language).success).toBe(true);
    expect(TranscriptionLanguageSchema.safeParse('pt-BR').success).toBe(false);
  });
});
