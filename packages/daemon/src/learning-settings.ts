import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UpdateLearningSettingsSchema,
  type LearningSettings, type LearningSettingsResponse, type UpdateLearningSettings,
} from '@nanachi/shared';
import { ApiError } from './api-error.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OLLAMA_BASE = 'http://127.0.0.1:11434';

function invalidSettings(): ApiError {
  return new ApiError(400, 'invalid_request', 'Invalid learning settings. Check the reviewer endpoint, key, and limits.');
}

/** Parse the literal authority as well as URL: WHATWG normalizes nonliteral IPv4 aliases. */
function validateBaseUrl(value: string): string {
  try {
    if (value !== value.trim() || /[\s\\?#]/u.test(value)) throw invalidSettings();
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw invalidSettings();
    const authority = /^[a-z]+:\/\/([^/]+)/iu.exec(value)?.[1];
    const literalLoopback = authority !== undefined && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/iu.test(authority);
    if (authority?.includes('@')) throw invalidSettings();
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && literalLoopback)) throw invalidSettings();
    return url.href.replace(/\/+$/u, '');
  } catch {
    throw invalidSettings();
  }
}

function normalize(settings: LearningSettings): LearningSettings {
  const reviewer = { ...settings.reviewer };
  if (reviewer.source === 'openrouter') {
    if (reviewer.baseUrl !== '' && validateBaseUrl(reviewer.baseUrl) !== OPENROUTER_BASE) throw invalidSettings();
    reviewer.baseUrl = OPENROUTER_BASE;
  } else if (reviewer.source === 'openai') {
    if (reviewer.baseUrl === '') throw invalidSettings();
    reviewer.baseUrl = validateBaseUrl(reviewer.baseUrl);
  } else if (reviewer.source === 'ollama') {
    reviewer.baseUrl = validateBaseUrl(reviewer.baseUrl || OLLAMA_BASE);
  } else if (reviewer.baseUrl !== '') {
    // Inactive endpoint fields must never persist embedded credentials either.
    reviewer.baseUrl = validateBaseUrl(reviewer.baseUrl);
  }
  return { ...settings, reviewer };
}

/** The key lives only in the owner's private daemon home; public snapshots are always redacted. */
export class LearningSettingsStore {
  private readonly file: string;
  private settings: LearningSettings;
  private key: string | undefined;

  constructor(home: string) {
    this.file = join(home, 'learning.json');
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/u, ''));
      chmodSync(this.file, 0o600);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw new ApiError(500, 'learning_settings_unavailable', 'Saved learning settings could not be read.');
      }
    }
    const parsed = UpdateLearningSettingsSchema.safeParse(raw);
    try {
      if (!parsed.success || parsed.data.removeApiKey !== undefined) throw invalidSettings();
      const { apiKey, removeApiKey: _removeApiKey, ...settings } = parsed.data;
      if (apiKey !== undefined && /[\r\n\u0000-\u001f\u007f]/u.test(apiKey)) throw invalidSettings();
      this.settings = normalize(settings);
      this.key = apiKey || undefined;
    } catch {
      throw new ApiError(500, 'learning_settings_unavailable', 'Saved learning settings are invalid.');
    }
  }

  get(): LearningSettingsResponse {
    return { ...this.settings, enabledAgents: [...this.settings.enabledAgents], reviewer: { ...this.settings.reviewer }, apiKeyConfigured: this.key !== undefined };
  }

  apiKey(): string | undefined {
    return this.key;
  }

  update(input: UpdateLearningSettings): LearningSettingsResponse {
    const parsed = UpdateLearningSettingsSchema.safeParse(input);
    if (!parsed.success) throw invalidSettings();
    const { apiKey, removeApiKey, ...raw } = parsed.data;
    if ((apiKey !== undefined && removeApiKey === true) || (apiKey !== undefined && /[\r\n\u0000-\u001f\u007f]/u.test(apiKey))) throw invalidSettings();
    const settings = normalize(raw);
    const sameDestination = settings.reviewer.source === this.settings.reviewer.source
      && settings.reviewer.baseUrl === this.settings.reviewer.baseUrl;
    const key = removeApiKey === true ? undefined : apiKey === undefined ? sameDestination ? this.key : undefined : apiKey || undefined;
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
      throw new ApiError(500, 'learning_settings_unavailable', 'Learning settings could not be saved.');
    } finally {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Keep the sanitized persistence error. */ } }
      try { rmSync(temporary, { force: true }); } catch { /* Never expose private filesystem details. */ }
    }
    this.settings = settings;
    this.key = key;
    return this.get();
  }
}
