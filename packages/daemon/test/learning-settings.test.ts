import { mkdtemp, readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningSettingsSchema, type UpdateLearningSettings } from '@nanachi/shared';
import { ApiError } from '../src/api-error.js';
import { LearningSettingsStore } from '../src/learning-settings.js';
import { removeTempDir } from './temp.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'nanachi-learning-settings-')); });
afterEach(async () => { await removeTempDir(home); });
const defaults = (): UpdateLearningSettings => LearningSettingsSchema.parse({});

describe('LearningSettingsStore', () => {
  it('defaults disabled and persists full private settings without returning the key', async () => {
    const store = new LearningSettingsStore(home);
    expect(store.get()).toEqual({ ...defaults(), apiKeyConfigured: false });
    const result = store.update({ ...defaults(), enabled: true, apiKey: 'synthetic-secret' });
    expect(result).toEqual({ ...defaults(), enabled: true, apiKeyConfigured: true });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(new LearningSettingsStore(home).apiKey()).toBe('synthetic-secret');
    const file = join(home, 'learning.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...defaults(), enabled: true, apiKey: 'synthetic-secret' });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(['learning.json']);
  });

  it('preserves an omitted key, clears removal, and never mutates returned snapshots', () => {
    const store = new LearningSettingsStore(home);
    store.update({ ...defaults(), apiKey: 'synthetic-secret' });
    const snapshot = store.get();
    snapshot.enabledAgents.push('not-saved');
    snapshot.reviewer.baseUrl = 'https://not-saved.invalid';
    store.update({ ...defaults(), intervalTurns: 7 });
    expect(store.apiKey()).toBe('synthetic-secret');
    expect(store.get().enabledAgents).toEqual([]);
    expect(store.get().reviewer.baseUrl).toBe('');
    store.update({ ...defaults(), removeApiKey: true });
    expect(store.apiKey()).toBeUndefined();
    expect(new LearningSettingsStore(home).get().apiKeyConfigured).toBe(false);
  });

  it('binds an omitted key to the same source and normalized endpoint only', () => {
    const store = new LearningSettingsStore(home);
    const reviewer = { source: 'openai' as const, agentId: '', model: '', baseUrl: 'https://models.example.com/v1/' };
    store.update({ ...defaults(), reviewer, apiKey: 'synthetic-secret' });
    store.update({ ...defaults(), reviewer: { ...reviewer, baseUrl: 'https://models.example.com/v1', model: 'changed-model' } });
    expect(store.apiKey()).toBe('synthetic-secret');
    store.update({ ...defaults(), reviewer: { ...reviewer, baseUrl: 'https://other.example.com/v1' } });
    expect(store.apiKey()).toBeUndefined();
    store.update({ ...defaults(), reviewer, apiKey: 'new-synthetic-secret' });
    store.update({ ...defaults(), reviewer: { ...reviewer, source: 'ollama' } });
    expect(store.apiKey()).toBeUndefined();
    expect(new LearningSettingsStore(home).apiKey()).toBeUndefined();
  });

  it('rejects unknown fields, invalid ranges, and conflicting key actions without leaking input', () => {
    const store = new LearningSettingsStore(home);
    for (const invalid of [
      { ...defaults(), timeoutMs: 1 },
      { ...defaults(), intervalTurns: 101 },
      { ...defaults(), apiKey: 'synthetic-secret', removeApiKey: true },
      { ...defaults(), apiKey: 'synthetic-secret\nheader' },
      { ...defaults(), unexpected: 'synthetic-secret' },
    ]) {
      try { store.update(invalid as UpdateLearningSettings); throw new Error('expected rejection'); }
      catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect(String(error)).not.toContain('synthetic-secret');
      }
    }
    expect(store.get().apiKeyConfigured).toBe(false);
  });

  it.each([
    'http://example.com/v1', 'http://127.1:11434', 'http://2130706433:11434',
    'http://127.0.0.2:11434', 'http://localhost.example.com',
    'https://user:synthetic-secret@example.com', 'https://example.com?api_key=synthetic-secret',
    'https://example.com/#synthetic-secret', 'file:///tmp/model', 'https://example.com?',
    'https://example.com/#',
    'https://@example.com', 'http://0x7f000001:11434', 'http://localhost.:11434',
  ])('rejects unsafe custom endpoint %s', (baseUrl) => {
    const store = new LearningSettingsStore(home);
    expect(() => store.update({ ...defaults(), reviewer: { source: 'openai', agentId: '', model: '', baseUrl } })).toThrow(ApiError);
  });

  it.each(['http://localhost:11434', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434', 'https://models.example.com/v1'])('accepts configured secure endpoint %s and empty discovery model', (baseUrl) => {
    const store = new LearningSettingsStore(home);
    expect(store.update({ ...defaults(), reviewer: { source: 'openai', agentId: '', model: '', baseUrl } }).reviewer.baseUrl).toBe(baseUrl);
  });

  it('requires a custom compatible endpoint and fixes the OpenRouter origin', () => {
    const store = new LearningSettingsStore(home);
    expect(() => store.update({ ...defaults(), reviewer: { source: 'openai', agentId: '', model: '', baseUrl: '' } })).toThrow(ApiError);
    expect(() => store.update({ ...defaults(), reviewer: { source: 'openrouter', agentId: '', model: '', baseUrl: 'https://example.com/api/v1' } })).toThrow(ApiError);
    expect(store.update({ ...defaults(), reviewer: { source: 'openrouter', agentId: '', model: '', baseUrl: '' } }).reviewer.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(store.update({ ...defaults(), reviewer: { source: 'ollama', agentId: '', model: '', baseUrl: '' } }).reviewer.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('does not change live settings or leave temporary files after persistence fails', async () => {
    const store = new LearningSettingsStore(home);
    await mkdir(join(home, 'learning.json'));
    expect(() => store.update({ ...defaults(), enabled: true, apiKey: 'synthetic-secret' })).toThrow(ApiError);
    expect(store.get().enabled).toBe(false);
    expect(store.apiKey()).toBeUndefined();
    expect(await readdir(home)).toEqual(['learning.json']);
  });

  it('fails closed with sanitized errors for corrupt persisted data', async () => {
    await writeFile(join(home, 'learning.json'), '{synthetic-secret');
    expect(() => new LearningSettingsStore(home)).toThrow('Saved learning settings could not be read.');
    try { new LearningSettingsStore(home); } catch (error) { expect(String(error)).not.toContain('synthetic-secret'); }
  });
});
