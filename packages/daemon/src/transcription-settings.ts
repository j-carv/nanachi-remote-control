import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UpdateTranscriptionSettingsSchema,
  type TranscriptionSettings, type TranscriptionSettingsResponse, type UpdateTranscriptionSettings,
} from '@nanachi/shared';
import { ApiError } from './api-error.js';

const OPENAI_BASE = 'https://api.openai.com/v1';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const LOCAL_MODEL = 'ggml-base-q5_1.bin';
const OPENAI_MODELS: Record<string, true> = { 'gpt-transcribe': true, 'gpt-4o-transcribe': true, 'gpt-4o-mini-transcribe': true };
const GROQ_MODELS: Record<string, true> = { 'whisper-large-v3-turbo': true, 'whisper-large-v3': true };

function invalidSettings(): ApiError {
  return new ApiError(400, 'invalid_request', 'Invalid transcription provider, model, endpoint, or credentials.');
}

/** Check the original authority too: URL otherwise accepts aliases such as 127.1 and hexadecimal IPv4. */
function validateBaseUrl(value: string): string {
  try {
    if (value !== value.trim() || /[\s\\?#\u0000-\u001f\u007f]/u.test(value)) throw invalidSettings();
    const authority = /^[a-z]+:\/\/([^/]+)/iu.exec(value)?.[1];
    if (authority === undefined || authority.includes('@')) throw invalidSettings();
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw invalidSettings();
    const host = authority.replace(/:[0-9]+$/u, '').toLowerCase();
    if (host !== url.hostname.toLowerCase()) throw invalidSettings();
    const loopback = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/iu.test(authority);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw invalidSettings();
    return url.href.replace(/\/+$/u, '');
  } catch {
    throw invalidSettings();
  }
}

function normalize(settings: TranscriptionSettings): TranscriptionSettings {
  const { provider, model } = settings;
  if (model !== '' && /[\s\u0000-\u001f\u007f]/u.test(model)) throw invalidSettings();
  if (provider === 'whisper') {
    if (model !== LOCAL_MODEL || settings.baseUrl !== '') throw invalidSettings();
    return { ...settings, baseUrl: '' };
  }
  if (provider === 'custom') {
    return { ...settings, baseUrl: settings.baseUrl === '' ? '' : validateBaseUrl(settings.baseUrl) };
  }
  const baseUrl = provider === 'openai' ? OPENAI_BASE : GROQ_BASE;
  const models = provider === 'openai' ? OPENAI_MODELS : GROQ_MODELS;
  if (model !== '' && !Object.hasOwn(models, model)) throw invalidSettings();
  if (settings.baseUrl !== '' && validateBaseUrl(settings.baseUrl) !== baseUrl) throw invalidSettings();
  return { ...settings, baseUrl };
}

/** Owner-private atomic persistence. Only redacted snapshots may cross the daemon API. */
export class TranscriptionSettingsService {
  private readonly file: string;
  private settings: TranscriptionSettings;
  private key: string | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(home: string) {
    this.file = join(home, 'transcription.json');
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/u, ''));
      chmodSync(this.file, 0o600);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new ApiError(500, 'transcription_settings_unavailable', 'Saved transcription settings could not be read.');
      }
    }
    try {
      const parsed = UpdateTranscriptionSettingsSchema.safeParse(raw);
      if (!parsed.success || parsed.data.removeApiKey !== undefined) throw invalidSettings();
      const { apiKey, removeApiKey: _removeApiKey, ...settings } = parsed.data;
      if (apiKey !== undefined && /[\u0000-\u001f\u007f]/u.test(apiKey)) throw invalidSettings();
      this.settings = normalize(settings);
      this.key = this.settings.provider === 'whisper' ? undefined : apiKey?.trim() || undefined;
    } catch {
      throw new ApiError(500, 'transcription_settings_unavailable', 'Saved transcription settings are invalid.');
    }
  }

  get(): TranscriptionSettingsResponse {
    return { ...this.settings, apiKeyConfigured: this.key !== undefined };
  }

  /** Capture the destination and key together, before starting any asynchronous work. */
  connection(): { settings: TranscriptionSettings; apiKey: string | undefined } {
    return { settings: { ...this.settings }, apiKey: this.key };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  update(input: UpdateTranscriptionSettings): TranscriptionSettingsResponse {
    const parsed = UpdateTranscriptionSettingsSchema.safeParse(input);
    if (!parsed.success) throw invalidSettings();
    const { apiKey, removeApiKey, ...raw } = parsed.data;
    if ((apiKey !== undefined && removeApiKey === true)
      || (apiKey !== undefined && /[\u0000-\u001f\u007f]/u.test(apiKey))) throw invalidSettings();
    const settings = normalize(raw);
    const sameDestination = settings.provider === this.settings.provider && settings.baseUrl === this.settings.baseUrl;
    const key = settings.provider === 'whisper' || removeApiKey === true ? undefined
      : apiKey === undefined ? sameDestination ? this.key : undefined : apiKey.trim() || undefined;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ ...settings, ...(key === undefined ? {} : { apiKey: key }) }, null, 2)}\n`);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.file);
    } catch {
      throw new ApiError(500, 'transcription_settings_unavailable', 'Transcription settings could not be saved.');
    } finally {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Preserve the private persistence error. */ } }
      try { rmSync(temporary, { force: true }); } catch { /* Do not expose filesystem details. */ }
    }
    this.settings = settings;
    this.key = key;
    for (const listener of this.listeners) listener();
    return this.get();
  }
}
