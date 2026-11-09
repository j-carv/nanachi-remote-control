import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TranscriptionSettingsSchema, WHISPER_MAX_WAV_BYTES, WHISPER_SAMPLE_RATE, type UpdateTranscriptionSettings } from '@nanachi/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionService } from '../src/transcription.js';
import { TranscriptionSettingsService } from '../src/transcription-settings.js';
import { WhisperService } from '../src/whisper.js';
import type { WhisperRuntime } from '../src/whisper-runtime.js';
import { authHeader } from './agent-support.js';
import { setupDaemonTests } from './support.js';

const env = setupDaemonTests();
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const defaults = TranscriptionSettingsSchema.parse({});

function wav(sample = 100): Buffer {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF');
  bytes.writeUInt32LE(38, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(WHISPER_SAMPLE_RATE, 24);
  bytes.writeUInt32LE(WHISPER_SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(2, 40);
  bytes.writeInt16LE(sample, 44);
  return bytes;
}

async function endpoint(handler: (request: IncomingMessage, reply: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, reply) => {
    void Promise.resolve(handler(request, reply)).catch(() => { reply.writeHead(500).end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Synthetic listener missing');
  return `http://127.0.0.1:${address.port}/v1`;
}

function provider(baseUrl: string, changes: Partial<UpdateTranscriptionSettings> = {}) {
  const settings = new TranscriptionSettingsService(env.home);
  settings.update({ ...defaults, provider: 'custom', model: 'owner/asr', baseUrl, ...changes });
  const whisper = new WhisperService(env.home, undefined, false);
  const service = new TranscriptionService(settings, whisper);
  cleanup.push(() => service.shutdown());
  return { service, settings, whisper };
}

async function multipart(request: IncomingMessage): Promise<FormData> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const parsed = new Request('http://127.0.0.1/', {
    method: 'POST', headers: { 'content-type': request.headers['content-type'] ?? '' }, body: Buffer.concat(chunks),
  });
  return parsed.formData();
}

describe('selected transcription providers', () => {
  it('posts real multipart WAV, exact model, supported language, and JSON response format without native installation', async () => {
    let received: FormData | undefined;
    let authorization: string | undefined;
    let path: string | undefined;
    const base = await endpoint(async (request, reply) => {
      received = await multipart(request);
      authorization = request.headers.authorization;
      path = request.url;
      reply.end(JSON.stringify({ text: '  Synthetic speech.  ' }));
    });
    const { service, whisper } = provider(base, { apiKey: 'synthetic-key' });
    expect(whisper.status()).toEqual({ state: 'unsupported' });
    expect(service.status()).toEqual({ provider: 'custom', model: 'owner/asr', state: 'ready' });
    expect(await service.transcribe(wav(), 'es', new AbortController().signal)).toEqual({ text: 'Synthetic speech.' });
    expect(path).toBe('/v1/audio/transcriptions');
    expect(authorization).toBe('Bearer synthetic-key');
    expect(received?.get('model')).toBe('owner/asr');
    expect(received?.get('language')).toBe('es');
    expect(received?.get('response_format')).toBe('json');
    const file = received?.get('file');
    if (file === undefined || file === null || typeof file === 'string') throw new Error('Synthetic WAV part missing');
    expect(file.type).toBe('audio/wav');
    expect(file.name).toBe('recording.wav');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(wav());
  });

  it.each([
    ['openai', 'gpt-transcribe', 'https://api.openai.com/v1/audio/transcriptions'],
    ['groq', 'whisper-large-v3-turbo', 'https://api.groq.com/openai/v1/audio/transcriptions'],
    ['groq', 'whisper-large-v3', 'https://api.groq.com/openai/v1/audio/transcriptions'],
  ] as const)('uses %s audio inference, not a chat request, for selected model %s', async (source, model, expectedUrl) => {
    let received: FormData | undefined;
    const base = await endpoint(async (request, reply) => {
      received = await multipart(request);
      reply.end(JSON.stringify({ text: 'Synthetic managed-provider recording.' }));
    });
    const nativeFetch = globalThis.fetch;
    const destinations: string[] = [];
    // Preserve the real HTTP multipart path while preventing all paid external traffic.
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      destinations.push(url);
      return nativeFetch(`${base}/audio/transcriptions`, init);
    });
    const { service } = provider('', { provider: source, model, apiKey: 'synthetic-key' });
    expect(await service.transcribe(wav(), 'en', new AbortController().signal)).toEqual({ text: 'Synthetic managed-provider recording.' });
    expect(destinations).toEqual([expectedUrl]);
    expect(received?.get('model')).toBe(model);
    expect(received?.get('language')).toBe('en');
    expect(received?.get('messages')).toBeNull();
  });

  it('uses only verified managed presets and marks legacy models deprecated without any network poll', async () => {
    const { service, settings } = provider('', { provider: 'openai', model: 'gpt-transcribe' });
    const network = vi.fn(() => { throw new Error('Unexpected paid network request'); });
    vi.stubGlobal('fetch', network);
    expect(service.status().state).toBe('configuration_required');
    expect(await service.models(new AbortController().signal)).toEqual({ manual: false, models: [
      { id: 'gpt-transcribe', name: 'GPT Transcribe', provider: 'openai' },
      { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe (legacy)', provider: 'openai', deprecated: true },
      { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe (legacy)', provider: 'openai', deprecated: true },
    ] });
    await expect(service.transcribe(wav(), 'pt', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_not_ready' });
    settings.update({ ...defaults, provider: 'groq', model: 'whisper-large-v3', apiKey: 'synthetic-key' });
    expect(service.status().state).toBe('ready');
    expect((await service.models(new AbortController().signal)).models.map((model) => model.id)).toEqual(['whisper-large-v3-turbo', 'whisper-large-v3']);
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps exact owner manual IDs but never labels an unannotated chat catalog as transcription-capable', async () => {
    const base = await endpoint((_request, reply) => { reply.end(JSON.stringify({ data: [
      { id: 'generic-chat-model' },
      { id: 'asr/parakeet', name: 'Owner Parakeet', task: 'automatic-speech-recognition' },
      { id: 'asr/qwen', capabilities: ['transcription'] },
      { id: 'asr/other', capabilities: { transcription: true } },
    ] })); });
    const { service } = provider(base);
    expect(await service.models(new AbortController().signal)).toEqual({ manual: true, models: [
      { id: 'owner/asr', name: 'owner/asr', provider: 'custom' },
      { id: 'asr/parakeet', name: 'Owner Parakeet', provider: 'custom' },
      { id: 'asr/qwen', name: 'asr/qwen', provider: 'custom' },
      { id: 'asr/other', name: 'asr/other', provider: 'custom' },
    ] });
  });

  it.each([404, 405, 501])('keeps manual configuration usable when discovery is unsupported (%s)', async (status) => {
    const base = await endpoint((_request, reply) => { reply.writeHead(status).end('synthetic-private-provider-body'); });
    const { service } = provider(base);
    expect(await service.models(new AbortController().signal)).toEqual({ manual: true, models: [{ id: 'owner/asr', name: 'owner/asr', provider: 'custom' }] });
  });

  it('rejects malformed, oversize, wrong-rate, and silent clips before sending a byte to a provider', async () => {
    let requests = 0;
    const base = await endpoint((_request, reply) => { requests += 1; reply.end('{"text":"not expected"}'); });
    const { service } = provider(base);
    const wrongRate = wav();
    wrongRate.writeUInt32LE(48000, 24);
    for (const bytes of [Buffer.from('bad WAV'), Buffer.alloc(WHISPER_MAX_WAV_BYTES + 1), wrongRate]) {
      await expect(service.transcribe(bytes, 'pt', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_invalid_audio' });
    }
    await expect(service.transcribe(wav(0), 'pt', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_no_speech' });
    expect(requests).toBe(0);
  });

  it('does not follow redirects, forward credentials, expose provider bodies, or fall back locally', async () => {
    let leakedRequests = 0;
    const target = await endpoint((_request, reply) => { leakedRequests += 1; reply.end('{"text":"not expected"}'); });
    const base = await endpoint((_request, reply) => { reply.writeHead(307, { location: `${target}/audio/transcriptions` }).end('synthetic-private-provider-body'); });
    const { service, whisper } = provider(base, { apiKey: 'synthetic-private-key' });
    const local = vi.spyOn(whisper, 'transcribe');
    await expect(service.transcribe(wav(), 'pt', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_failed', message: 'Transcription provider request failed.' });
    expect(leakedRequests).toBe(0);
    expect(local).not.toHaveBeenCalled();
  });

  it.each(['bad-json', 'empty', 'chat', 'oversize', 'denied'])('sanitizes %s responses without retries or fallback', async (kind) => {
    let requests = 0;
    const base = await endpoint((_request, reply) => {
      requests += 1;
      if (kind === 'denied') reply.writeHead(401).end('synthetic-private-key and recording');
      else if (kind === 'bad-json') reply.end('{synthetic-private-key');
      else if (kind === 'empty') reply.end('{"text":"   "}');
      else if (kind === 'chat') reply.end('{"choices":[{"message":{"content":"not STT"}}]}');
      else { reply.write(' '.repeat(1024 * 1024)); reply.end(' '.repeat(1024 * 1024)); }
    });
    const { service } = provider(base);
    await expect(service.transcribe(wav(), 'en', new AbortController().signal)).rejects.toMatchObject({ code: kind === 'empty' ? 'transcription_no_speech' : 'transcription_failed' });
    expect(requests).toBe(1);
  });

  it('permits only one clip and aborts a hanging response body on disconnect', async () => {
    let received!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    const base = await endpoint((_request, reply) => { reply.writeHead(200); reply.write('{'); received(); });
    const { service } = provider(base);
    const controller = new AbortController();
    const pending = service.transcribe(wav(), 'pt', controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'transcription_cancelled' });
    await started;
    expect(service.status().state).toBe('busy');
    await expect(service.transcribe(wav(), 'es', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_busy' });
    controller.abort(new Error('synthetic-private-reason'));
    await rejection;
    expect(service.status().state).toBe('ready');
  });

  it('aborts requests and drops old credentials before a changed destination can receive audio', async () => {
    let received!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    const oldBase = await endpoint((_request, reply) => { reply.writeHead(200); reply.write('{'); received(); });
    let authorization: string | undefined;
    const nextBase = await endpoint((request, reply) => { authorization = request.headers.authorization; reply.end('{"text":"New owner endpoint."}'); });
    const { service, settings } = provider(oldBase, { apiKey: 'synthetic-old-key' });
    const pending = service.transcribe(wav(), 'pt', new AbortController().signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'transcription_cancelled' });
    await started;
    settings.update({ ...defaults, provider: 'custom', model: 'next/asr', baseUrl: nextBase });
    await rejection;
    expect(settings.get().apiKeyConfigured).toBe(false);
    expect(await service.transcribe(wav(), 'pt', new AbortController().signal)).toEqual({ text: 'New owner endpoint.' });
    expect(authorization).toBeUndefined();
  });

  it('cancels discovery and inference on shutdown and rejects any later work', async () => {
    let requests = 0;
    const base = await endpoint((_request, reply) => { requests += 1; reply.writeHead(200); reply.write('{'); });
    const { service } = provider(base);
    const inference = expect(service.transcribe(wav(), 'en', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_cancelled' });
    const catalog = expect(service.models(new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_cancelled' });
    await vi.waitFor(() => expect(requests).toBe(2));
    await service.shutdown();
    await Promise.all([inference, catalog]);
    expect(service.status().state).toBe('not_ready');
    await expect(service.transcribe(wav(), 'en', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_not_ready' });
  });

  it('enforces an absolute deadline while a provider dribbles an unfinished JSON body', async () => {
    const base = await endpoint((_request, reply) => { reply.writeHead(200); reply.write('{'); });
    const { service } = provider(base, { timeoutMs: 5000 });
    const start = Date.now();
    await expect(service.transcribe(wav(), 'pt', new AbortController().signal)).rejects.toMatchObject({ code: 'transcription_timeout' });
    expect(Date.now() - start).toBeLessThan(9000);
    expect(service.status().state).toBe('ready');
  }, 10000);

  it('discards a late local result after switching sources even if the runtime ignores abort', async () => {
    let complete!: (text: string) => void;
    const late = new Promise<string>((resolve) => { complete = resolve; });
    let received!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    const runtime: WhisperRuntime = {
      async install(dir) { await writeFile(join(dir, 'engine.exe'), 'fixture'); await writeFile(join(dir, 'model.bin'), 'fixture'); },
      async locate(dir) { const cli = join(dir, 'engine.exe'); const model = join(dir, 'model.bin'); await Promise.all([stat(cli), stat(model)]); return { cli, model }; },
      async transcribe(_installation, dir) { expect(await readFile(join(dir, 'input.wav'))).toEqual(wav()); received(); return late; },
    };
    const whisper = new WhisperService(env.home, runtime, true);
    whisper.install();
    await vi.waitFor(() => expect(whisper.status().state).toBe('ready'));
    const settings = new TranscriptionSettingsService(env.home);
    const service = new TranscriptionService(settings, whisper);
    cleanup.push(async () => { await service.shutdown(); await whisper.shutdown(); });
    const pending = service.transcribe(wav(), 'en', new AbortController().signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'transcription_cancelled' });
    await started;
    settings.update({ ...defaults, provider: 'custom', model: 'owner/asr', baseUrl: 'http://127.0.0.1:8000/v1' });
    complete('Old source text must not appear.');
    await rejection;
    expect(service.status()).toEqual({ provider: 'custom', model: 'owner/asr', state: 'ready' });
  });
});

describe('canonical transcription HTTP API', () => {
  it('protects every endpoint, redacts keys, selects remote readiness, and removes the old inference route', async () => {
    const base = await endpoint(async (request, reply) => {
      if (request.method === 'POST') { await multipart(request); reply.end('{"text":"Synthetic HTTP recording."}'); }
      else reply.end('{"data":[{"id":"owner/asr","task":"transcription"}]}');
    });
    const daemon = await env.start({ whisper: new WhisperService(env.home, undefined, false) });
    const headers = await authHeader(daemon);
    const { app } = daemon;
    for (const [method, url] of [
      ['GET', '/api/transcription/settings'], ['PUT', '/api/transcription/settings'],
      ['GET', '/api/transcription/status'], ['GET', '/api/transcription/models'],
      ['POST', '/api/transcription/transcribe?language=pt'],
    ] as const) expect((await app.inject({ method, url })).statusCode).toBe(401);
    const initial = await app.inject({ url: '/api/transcription/settings', headers });
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.json()).toEqual({ ...defaults, apiKeyConfigured: false });
    expect((await app.inject({ url: '/api/transcription/status', headers })).json()).toEqual({ provider: 'whisper', model: 'ggml-base-q5_1.bin', state: 'unsupported' });
    const saved = await app.inject({ method: 'PUT', url: '/api/transcription/settings', headers, payload: { ...defaults, provider: 'custom', model: 'owner/asr', baseUrl: base, apiKey: 'synthetic-private-key' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('synthetic-private-key');
    expect(saved.json().apiKeyConfigured).toBe(true);
    expect((await app.inject({ url: '/api/transcription/status', headers })).json()).toEqual({ provider: 'custom', model: 'owner/asr', state: 'ready' });
    expect((await app.inject({ url: '/api/whisper', headers })).json()).toEqual({ state: 'unsupported' });
    const transcript = await app.inject({ method: 'POST', url: '/api/transcription/transcribe?language=pt', headers: { ...headers, 'content-type': 'audio/wav' }, payload: wav() });
    expect(transcript.statusCode).toBe(200);
    expect(transcript.json()).toEqual({ text: 'Synthetic HTTP recording.' });
    expect(transcript.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'POST', url: '/api/whisper/transcribe?language=pt', headers })).statusCode).toBe(404);
    const rejected = await app.inject({ method: 'PUT', url: '/api/transcription/settings', headers, payload: { ...defaults, provider: 'openai', model: 'gpt-4o' } });
    expect(rejected.statusCode).toBe(400);
    expect((await app.inject({ url: '/api/transcription/settings', headers })).json().provider).toBe('custom');
  });

  it('aborts the actual provider response body when the HTTP dictation client disconnects', async () => {
    let received!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    let closed = false;
    const base = await endpoint((_request, reply) => {
      reply.once('close', () => { closed = true; });
      reply.writeHead(200); reply.write('{'); received();
    });
    const daemon = await env.start({ whisper: new WhisperService(env.home, undefined, false) });
    const headers = await authHeader(daemon);
    await daemon.app.inject({ method: 'PUT', url: '/api/transcription/settings', headers, payload: { ...defaults, provider: 'custom', model: 'owner/asr', baseUrl: base } });
    const address = await daemon.app.listen({ host: '127.0.0.1', port: 0 });
    const client = httpRequest(`${address}/api/transcription/transcribe?language=en`, { method: 'POST', headers: { ...headers, 'content-type': 'audio/wav' } });
    client.on('error', () => { /* Deliberate microphone-client disconnect. */ });
    client.end(wav());
    await started;
    client.destroy();
    await vi.waitFor(() => expect(closed).toBe(true));
    await vi.waitFor(async () => expect((await daemon.app.inject({ url: '/api/transcription/status', headers })).json().state).toBe('ready'));
  });

  it('reserves the single clip during upload and stops reading the old clip immediately on a settings change', async () => {
    let requests = 0;
    let model: unknown;
    const base = await endpoint(async (request, reply) => {
      requests += 1;
      model = (await multipart(request)).get('model');
      reply.end('{"text":"New source recording."}');
    });
    const daemon = await env.start({ whisper: new WhisperService(env.home, undefined, false) });
    const headers = await authHeader(daemon);
    const connection = { ...defaults, provider: 'custom' as const, model: 'owner/old', baseUrl: base };
    await daemon.app.inject({ method: 'PUT', url: '/api/transcription/settings', headers, payload: connection });
    const address = await daemon.app.listen({ host: '127.0.0.1', port: 0 });
    const client = httpRequest(`${address}/api/transcription/transcribe?language=en`, { method: 'POST', headers: { ...headers, 'content-type': 'audio/wav' } });
    let closed = false;
    client.on('error', () => { /* Changing the source deliberately interrupts the pending upload. */ });
    client.on('close', () => { closed = true; });
    client.on('response', (reply) => reply.resume());
    client.write(wav().subarray(0, 44));
    await vi.waitFor(async () => expect((await daemon.app.inject({ url: '/api/transcription/status', headers })).json().state).toBe('busy'));
    expect((await daemon.app.inject({
      method: 'POST', url: '/api/transcription/transcribe?language=pt',
      headers: { ...headers, 'content-type': 'audio/wav' }, payload: wav(),
    })).json()).toEqual({ error: 'transcription_busy' });
    expect((await daemon.app.inject({
      method: 'PUT', url: '/api/transcription/settings', headers,
      payload: { ...connection, model: 'owner/next' },
    })).statusCode).toBe(200);
    await vi.waitFor(() => expect(closed).toBe(true));
    await vi.waitFor(async () => expect((await daemon.app.inject({ url: '/api/transcription/status', headers })).json().state).toBe('ready'));
    expect(requests).toBe(0);
    const result = await daemon.app.inject({
      method: 'POST', url: '/api/transcription/transcribe?language=pt',
      headers: { ...headers, 'content-type': 'audio/wav' }, payload: wav(),
    });
    expect(result.json()).toEqual({ text: 'New source recording.' });
    expect(model).toBe('owner/next');
  });
});
