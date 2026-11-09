import { mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WHISPER_MAX_WAV_BYTES, WHISPER_SAMPLE_RATE } from '@nanachi/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { WhisperService } from '../src/whisper.js';
import { whisperRuntime, type WhisperRuntime } from '../src/whisper-runtime.js';
import { authHeader } from './agent-support.js';
import { setupDaemonTests } from './support.js';

const env = setupDaemonTests();
afterEach(() => vi.unstubAllGlobals());

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

function runtime(overrides: Partial<WhisperRuntime> = {}): WhisperRuntime {
  return {
    async install(dir, _signal, progress) {
      await writeFile(join(dir, 'engine.exe'), 'test runtime');
      await writeFile(join(dir, 'model.bin'), 'test model');
      progress(99);
    },
    async locate(dir) {
      const cli = join(dir, 'engine.exe');
      const model = join(dir, 'model.bin');
      await Promise.all([stat(cli), stat(model)]);
      return { cli, model };
    },
    async transcribe(_installation, dir) {
      expect(await readFile(join(dir, 'input.wav'))).toEqual(wav());
      return '  Olá, Nanachi.  ';
    },
    ...overrides,
  };
}

it('installs once for paired devices, transcribes, removes, and reinstalls', async () => {
  const backend = runtime();
  const install = vi.spyOn(backend, 'install');
  const service = new WhisperService(env.home, backend, true);
  const { app, ...daemon } = await env.start({ whisper: service });
  const phone = await authHeader({ app, ...daemon });
  const desktop = await authHeader({ app, ...daemon });
  const root = '/api/whisper';
  const transcribe = (payload: Buffer, language = 'pt', headers: Record<string, string> = phone) => app.inject({
    method: 'POST', url: `/api/transcription/transcribe?language=${language}`,
    headers: { ...headers, 'content-type': 'audio/wav' }, payload,
  });
  for (const [method, url] of [['GET', root], ['POST', `${root}/install`], ['DELETE', root]] as const) {
    expect((await app.inject({ method, url })).statusCode).toBe(401);
  }
  expect((await transcribe(wav(), 'pt', {})).statusCode).toBe(401);
  expect((await app.inject({ url: root, headers: phone })).json()).toEqual({ state: 'disabled' });
  expect((await transcribe(wav())).json()).toEqual({ error: 'transcription_not_ready' });
  const starts = await Promise.all([phone, desktop].map((headers) =>
    app.inject({ method: 'POST', url: `${root}/install`, headers })));
  expect(starts.every((result) => result.statusCode === 202 || result.statusCode === 200)).toBe(true);
  await vi.waitFor(() => expect(service.status()).toEqual({ state: 'ready' }));
  expect(install).toHaveBeenCalledTimes(1);
  expect((await app.inject({ url: root, headers: desktop })).json()).toEqual({ state: 'ready' });
  expect((await transcribe(wav(), 'xx')).statusCode).toBe(400);
  expect((await transcribe(Buffer.from('bad WAV'))).statusCode).toBe(400);
  expect((await transcribe(Buffer.alloc(WHISPER_MAX_WAV_BYTES + 1))).statusCode).toBe(413);
  expect((await transcribe(wav(0))).json()).toEqual({ error: 'transcription_no_speech' });
  const reply = await transcribe(wav());
  expect(reply.headers['cache-control']).toBe('no-store');
  expect(reply.json()).toEqual({ text: 'Olá, Nanachi.' });
  expect(await readdir(join(env.home, 'whisper', 'jobs'))).toEqual([]);

  expect((await app.inject({ method: 'DELETE', url: root, headers: desktop })).statusCode).toBe(202);
  await vi.waitFor(() => expect(service.status()).toEqual({ state: 'disabled' }));
  expect(await readdir(join(env.home, 'whisper'))).toEqual([]);
  expect((await app.inject({ method: 'POST', url: `${root}/install`, headers: phone })).statusCode).toBe(202);
  await vi.waitFor(() => expect(service.status()).toEqual({ state: 'ready' }));
  expect(install).toHaveBeenCalledTimes(2);
});

it('aborts a transcription and waits for cleanup before removing', async () => {
  const backend = runtime({
    transcribe: vi.fn(async (_installation, _dir, _language, signal) => {
      signal.throwIfAborted();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }),
  });
  const service = new WhisperService(env.home, backend, true);
  const signal = new AbortController().signal;
  service.install();
  await vi.waitFor(() => expect(service.status().state).toBe('ready'));
  const result = expect(service.transcribe(wav(), 'pt', signal)).rejects.toMatchObject({ code: 'whisper_cancelled' });
  await vi.waitFor(() => expect(backend.transcribe).toHaveBeenCalledTimes(1));
  await expect(service.transcribe(wav(), 'pt', signal)).rejects.toMatchObject({ code: 'whisper_busy' });
  expect(service.remove()).toEqual({ state: 'removing' });
  await result;
  await vi.waitFor(() => expect(service.status()).toEqual({ state: 'disabled' }));
  expect(await readdir(join(env.home, 'whisper'))).toEqual([]);
});

it('discards interrupted staging and finishes a pending removal at startup', async () => {
  const root = join(env.home, 'whisper');
  await mkdir(join(root, 'staging'), { recursive: true });
  await writeFile(join(root, 'staging', 'runtime.zip'), 'partial');
  const backend = runtime();
  const service = new WhisperService(env.home, backend, true);
  await service.initialize();
  expect(service.status()).toEqual({ state: 'disabled' });
  expect(await readdir(root)).toEqual([]);
  service.install();
  await vi.waitFor(() => expect(service.status().state).toBe('ready'));
  await service.shutdown();
  const restarted = new WhisperService(env.home, backend, true);
  await restarted.initialize();
  expect(restarted.status()).toEqual({ state: 'ready' });
  await writeFile(join(root, 'removal-pending'), '');
  const recovering = new WhisperService(env.home, backend, true);
  await recovering.initialize();
  expect(recovering.status()).toEqual({ state: 'disabled' });
  expect(await readdir(root)).toEqual([]);
});

it('leaves junction targets intact and lets the user retry a failed removal', async () => {
  const root = join(env.home, 'whisper');
  const service = new WhisperService(env.home, runtime(), true);
  service.install();
  await vi.waitFor(() => expect(service.status().state).toBe('ready'));
  const outside = join(env.home, 'other-data');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep this');
  await symlink(outside, join(root, 'installed', 'unexpected-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const obstruction = join(root, 'jobs');
  await writeFile(obstruction, 'unexpected file');
  service.remove();
  await vi.waitFor(() => expect(service.status().state).toBe('remove_failed'));
  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep this');
  await unlink(obstruction);
  service.remove();
  await vi.waitFor(() => expect(service.status().state).toBe('disabled'));
  expect(await readdir(root)).toEqual([]);
});

it.each(['download', 'checksum'])('keeps Whisper disabled after a %s failure', async (failure) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (failure === 'download') throw new Error('network unavailable');
    expect(url).toContain('github.com/ggml-org/whisper.cpp/releases/download/b5454/');
    return new Response('corrupt archive');
  }));
  const service = new WhisperService(env.home, whisperRuntime, true);
  service.install();
  await vi.waitFor(() => expect(service.status()).toEqual({ state: 'install_failed' }));
  expect(await readdir(join(env.home, 'whisper'))).toEqual([]);
});
