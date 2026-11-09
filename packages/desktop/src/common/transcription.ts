import type { TranscriptionModelsResponse, TranscriptionProvider, TranscriptionSettings, TranscriptionSettingsResponse, TranscriptionStatus, UpdateTranscriptionSettings } from '@nanachi/shared';

// Runtime guards stay dependency-free: the packaged Desktop bundles shared types, not Zod.
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function provider(value: unknown): value is TranscriptionProvider {
  return value === 'whisper' || value === 'openai' || value === 'groq' || value === 'custom';
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
function settings(value: unknown): value is TranscriptionSettings & Record<string, unknown> {
  return record(value) && provider(value.provider) && text(value.model, 500) && text(value.baseUrl, 2000)
    && typeof value.timeoutMs === 'number' && Number.isInteger(value.timeoutMs) && value.timeoutMs >= 5000 && value.timeoutMs <= 180000;
}
const SETTINGS_FIELDS = ['provider', 'model', 'baseUrl', 'timeoutMs'] as const;
const UPDATE_FIELDS: readonly string[] = [...SETTINGS_FIELDS, 'apiKey', 'removeApiKey'];
const RESPONSE_FIELDS: readonly string[] = [...SETTINGS_FIELDS, 'apiKeyConfigured'];

export function parseTranscriptionUpdate(value: unknown): UpdateTranscriptionSettings | null {
  if (!settings(value) || Object.keys(value).some((key) => !UPDATE_FIELDS.includes(key))
    || (value.apiKey !== undefined && !text(value.apiKey, 8000))
    || (value.removeApiKey !== undefined && typeof value.removeApiKey !== 'boolean')) return null;
  return { provider: value.provider, model: value.model, baseUrl: value.baseUrl, timeoutMs: value.timeoutMs,
    ...(typeof value.apiKey === 'string' ? { apiKey: value.apiKey } : {}),
    ...(typeof value.removeApiKey === 'boolean' ? { removeApiKey: value.removeApiKey } : {}) };
}

export function parseTranscriptionSettings(value: unknown): TranscriptionSettingsResponse | null {
  if (!settings(value) || Object.keys(value).some((key) => !RESPONSE_FIELDS.includes(key)) || typeof value.apiKeyConfigured !== 'boolean') return null;
  return { provider: value.provider, model: value.model, baseUrl: value.baseUrl, timeoutMs: value.timeoutMs, apiKeyConfigured: value.apiKeyConfigured };
}

export function parseTranscriptionStatus(value: unknown): TranscriptionStatus | null {
  if (!record(value) || !provider(value.provider) || !text(value.model, 500)
    || (value.state !== 'ready' && value.state !== 'not_ready' && value.state !== 'configuration_required' && value.state !== 'busy' && value.state !== 'unsupported')) return null;
  return { provider: value.provider, model: value.model, state: value.state };
}

export function parseTranscriptionModels(value: unknown): TranscriptionModelsResponse | null {
  if (!record(value) || !Array.isArray(value.models) || value.models.length > 1000 || typeof value.manual !== 'boolean') return null;
  const models: TranscriptionModelsResponse['models'] = [];
  for (const item of value.models) {
    if (!record(item) || !provider(item.provider) || !text(item.id, 500) || item.id.length === 0 || /[\s\u0000-\u001f\u007f]/u.test(item.id)
      || !text(item.name, 500) || item.name.length === 0 || (item.deprecated !== undefined && typeof item.deprecated !== 'boolean')) return null;
    models.push({ id: item.id, name: item.name, provider: item.provider, ...(typeof item.deprecated === 'boolean' ? { deprecated: item.deprecated } : {}) });
  }
  return { models, manual: value.manual };
}
