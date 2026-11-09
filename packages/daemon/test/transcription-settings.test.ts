import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptionSettingsSchema, type UpdateTranscriptionSettings } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api-error.js';
import { TranscriptionSettingsService } from '../src/transcription-settings.js';
import { removeTempDir } from './temp.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'nanachi-transcription-settings-')); });
afterEach(async () => { await removeTempDir(home); });
const defaults = TranscriptionSettingsSchema.parse({});
const custom: UpdateTranscriptionSettings = { ...defaults, provider: 'custom', model: 'owner/asr', baseUrl: 'http://127.0.0.1:8000/v1' };

describe('TranscriptionSettingsService', () => {
  it('defaults to the original offline engine and atomically persists only owner-private configuration', async () => {
    const store = new TranscriptionSettingsService(home);
    expect(store.get()).toEqual({ provider: 'whisper', model: 'ggml-base-q5_1.bin', baseUrl: '', timeoutMs: 90000, apiKeyConfigured: false });
    expect(await readdir(home)).toEqual([]);
    const saved = store.update({ ...custom, apiKey: 'synthetic-private-key' });
    expect(saved).toEqual({ ...custom, apiKeyConfigured: true });
    expect(JSON.stringify(saved)).not.toContain('synthetic-private-key');
    expect(new TranscriptionSettingsService(home).get()).toEqual(saved);
    const file = join(home, 'transcription.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...custom, apiKey: 'synthetic-private-key' });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(['transcription.json']);
  });

  it('binds an omitted key to the provider and canonical destination, not the model', () => {
    const store = new TranscriptionSettingsService(home);
    store.update({ ...custom, baseUrl: `${custom.baseUrl}/`, apiKey: 'synthetic-key' });
    expect(store.update({ ...custom, model: 'different/asr' }).apiKeyConfigured).toBe(true);
    expect(store.update({ ...custom, baseUrl: 'http://127.0.0.1:8001/v1' }).apiKeyConfigured).toBe(false);
    store.update({ ...custom, apiKey: 'synthetic-key' });
    expect(store.update({ ...defaults, provider: 'openai', model: 'gpt-transcribe' }).apiKeyConfigured).toBe(false);
    expect(new TranscriptionSettingsService(home).get().apiKeyConfigured).toBe(false);
  });

  it('supports explicit removal and never lets returned snapshots alter live configuration', () => {
    const store = new TranscriptionSettingsService(home);
    store.update({ ...custom, apiKey: 'synthetic-key' });
    const snapshot = store.get();
    snapshot.model = 'changed-outside-store';
    expect(store.get().model).toBe(custom.model);
    expect(store.update({ ...custom, removeApiKey: true }).apiKeyConfigured).toBe(false);
    expect(new TranscriptionSettingsService(home).get().apiKeyConfigured).toBe(false);
  });

  it.each([
    'http://example.com/v1', 'http://127.1:8000', 'https://127.1:8000', 'http://2130706433:8000',
    'http://127.0.0.2:8000', 'http://0x7f000001:8000', 'http://localhost.example.com:8000',
    'http://localhost.:8000', 'https://user:synthetic-secret@example.com/v1',
    'https://example.com/v1?api_key=synthetic-secret', 'https://example.com/#synthetic-secret',
    'https://example.com?', 'https://example.com/#', 'https://@example.com',
    'file:///tmp/asr', 'https://example.com\\@localhost',
  ])('rejects unsafe or ambiguous custom destination %s', (baseUrl) => {
    const store = new TranscriptionSettingsService(home);
    expect(() => store.update({ ...custom, baseUrl })).toThrow(ApiError);
    expect(store.get()).toEqual({ ...defaults, apiKeyConfigured: false });
  });

  it.each(['http://localhost:8000/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1', 'https://asr.example.com/v1'])('accepts secure custom endpoint %s', (baseUrl) => {
    expect(new TranscriptionSettingsService(home).update({ ...custom, baseUrl }).baseUrl).toBe(baseUrl);
  });

  it('refuses chat models or alternate destinations for managed providers', () => {
    const store = new TranscriptionSettingsService(home);
    for (const input of [
      { ...defaults, model: 'another-local-model' },
      { ...defaults, provider: 'openai', model: 'gpt-4o' },
      { ...defaults, provider: 'groq', model: 'llama-3.3-70b-versatile' },
      { ...defaults, provider: 'openai', model: 'gpt-transcribe', baseUrl: custom.baseUrl },
      { ...custom, model: 'model with spaces' },
      { ...custom, apiKey: 'synthetic-key\nheader' },
      { ...custom, apiKey: 'synthetic-key', removeApiKey: true },
      { ...custom, timeoutMs: 1 },
      { ...custom, unexpected: 'synthetic-secret' },
    ]) expect(() => store.update(input as UpdateTranscriptionSettings)).toThrow(ApiError);
    expect(store.get()).toEqual({ ...defaults, apiKeyConfigured: false });
  });

  it('does not mutate live credentials or notify a source change when persistence fails', async () => {
    const store = new TranscriptionSettingsService(home);
    let changes = 0;
    store.onChange(() => { changes += 1; });
    await mkdir(join(home, 'transcription.json'));
    expect(() => store.update({ ...custom, apiKey: 'synthetic-secret' })).toThrow('Transcription settings could not be saved.');
    expect(store.get()).toEqual({ ...defaults, apiKeyConfigured: false });
    expect(changes).toBe(0);
    expect(await readdir(home)).toEqual(['transcription.json']);
  });

  it('fails closed and sanitizes corrupt persisted secrets', async () => {
    await writeFile(join(home, 'transcription.json'), '{synthetic-secret');
    expect(() => new TranscriptionSettingsService(home)).toThrow('Saved transcription settings could not be read.');
    await writeFile(join(home, 'transcription.json'), JSON.stringify({ ...custom, baseUrl: 'http://2130706433:8000', apiKey: 'synthetic-secret' }));
    expect(() => new TranscriptionSettingsService(home)).toThrow('Saved transcription settings are invalid.');
  });
});
