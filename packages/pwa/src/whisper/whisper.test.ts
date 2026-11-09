import { WHISPER_MAX_WAV_BYTES, WHISPER_SAMPLE_RATE } from '@nanachi/shared';
import { expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import { whisperWav } from './recording.js';
import { appendWhisperTranscript } from './useWhisperDictation.js';

it('encodes mono 16-bit PCM with the duration cap', async () => {
  const clip = whisperWav(Float32Array.from([-2, 0, 2]));
  const bytes = Buffer.from(await clip.arrayBuffer());
  expect(clip.type).toBe('audio/wav');
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
  expect(bytes.readUInt16LE(22)).toBe(1);
  expect(bytes.readUInt32LE(24)).toBe(WHISPER_SAMPLE_RATE);
  expect(bytes.readUInt16LE(34)).toBe(16);
  expect(bytes.readUInt32LE(40)).toBe(6);
  expect([44, 46, 48].map((offset) => bytes.readInt16LE(offset))).toEqual([-32768, 0, 32767]);
  expect(whisperWav(new Float32Array(WHISPER_SAMPLE_RATE * 61)).size).toBe(WHISPER_MAX_WAV_BYTES);
});

it('preserves the current draft and its spacing when dictation finishes', () => {
  expect(appendWhisperTranscript('', 'Olá')).toBe('Olá');
  expect(appendWhisperTranscript('Revise isto', 'e rode os testes.')).toBe('Revise isto e rode os testes.');
  expect(appendWhisperTranscript('Notas:\n', 'Rode os testes.')).toBe('Notas:\nRode os testes.');
});

it('sends WAV only to the authenticated transcription route', async () => {
  const fetcher = vi.fn(async () => Response.json({ text: 'Olá, Nanachi.' }));
  const api = createApiClient({ baseUrl: 'https://test.example', token: 'fixture' }, fetcher);
  const audio = whisperWav(Float32Array.of(1));
  const { signal } = new AbortController();
  await expect(api.transcribeAudio(audio, 'pt', signal)).resolves.toEqual({ text: 'Olá, Nanachi.' });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://test.example/api/transcription/transcribe?language=pt', {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'audio/wav' }, body: audio, signal,
  });
});

it('reads selected-provider settings, readiness and model catalogs through the generic API', async () => {
  const settings = { provider: 'groq', model: 'whisper-large-v3-turbo', baseUrl: '', timeoutMs: 90000, apiKeyConfigured: true };
  const status = { provider: settings.provider, model: settings.model, state: 'ready' };
  const catalog = { models: [{ provider: 'groq', id: settings.model, name: 'Whisper Large v3 Turbo' }], manual: false };
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/settings')) return Response.json(settings);
    if (String(url).endsWith('/status')) return Response.json(status);
    return Response.json(catalog);
  });
  const api = createApiClient({ baseUrl: 'https://test.example', token: 'fixture' }, fetcher);
  await expect(api.transcriptionSettings()).resolves.toEqual(settings);
  await expect(api.transcriptionStatus()).resolves.toEqual(status);
  await expect(api.transcriptionModels()).resolves.toEqual(catalog);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://test.example/api/transcription/settings',
    'https://test.example/api/transcription/status',
    'https://test.example/api/transcription/models',
  ]);
});

it('saves write-only connection credentials only through an authenticated PUT', async () => {
  const input = { provider: 'custom' as const, model: 'parakeet', baseUrl: 'http://127.0.0.1:8000/v1', timeoutMs: 30000, apiKey: 'private-fixture' };
  const { apiKey: _secret, ...publicSettings } = input;
  const confirmed = { ...publicSettings, apiKeyConfigured: true };
  const fetcher = vi.fn(async () => Response.json(confirmed));
  const api = createApiClient({ baseUrl: 'https://test.example', token: 'fixture' }, fetcher);
  await expect(api.setTranscriptionSettings(input)).resolves.toEqual(confirmed);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://test.example/api/transcription/settings', {
    method: 'PUT', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
});

it('rejects invalid settings and audio before sending any request', async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  const api = createApiClient({ baseUrl: 'https://test.example', token: 'fixture' }, fetcher);
  await expect(api.setTranscriptionSettings({ provider: 'whisper', model: 'ggml-base-q5_1.bin', baseUrl: '', timeoutMs: 1 })).rejects.toMatchObject({ kind: 'invalid_input' });
  await expect(api.transcribeAudio(new Blob(['text'], { type: 'text/plain' }), 'en', new AbortController().signal)).rejects.toMatchObject({ kind: 'invalid_input' });
  expect(fetcher).not.toHaveBeenCalled();
});
