import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { lstat, open, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { WhisperLanguage } from '@nanachi/shared';
import extract from 'extract-zip';

const ARCHIVE = {
  url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  maxBytes: 16 * 1024 * 1024,
  expectedBytes: 8_520_000,
};
const MODEL = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb45af861ab5e5297d23694b7d46e090c02c/ggml-base-q5_1.bin',
  sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  maxBytes: 70 * 1024 * 1024,
  expectedBytes: 59_700_000,
};
const MODEL_NAME = 'ggml-base-q5_1.bin';
const CLI_NAME = 'whisper-cli.exe';

export interface WhisperInstallation {
  cli: string;
  model: string;
}

export interface WhisperRuntime {
  install(dir: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void>;
  locate(dir: string): Promise<WhisperInstallation>;
  transcribe(installation: WhisperInstallation, dir: string, language: WhisperLanguage, signal: AbortSignal): Promise<string>;
}

async function downloadResponse(url: string, signal: AbortSignal): Promise<Response> {
  let next = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (next.protocol !== 'https:') break;
    const response = await fetch(next.href, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (location === null) break;
    next = new URL(location, next);
  }
  throw new Error('Invalid Whisper download redirect');
}

async function download(
  artifact: typeof ARCHIVE,
  path: string,
  signal: AbortSignal,
  progress: (received: number) => void,
): Promise<void> {
  const response = await downloadResponse(artifact.url, signal);
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error('Whisper download failed');
  }

  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let size = 0;
  try {
    const file = await open(path, 'wx');
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > artifact.maxBytes) throw new Error('Whisper artifact is too large');
        hash.update(result.value);
        await file.writeFile(result.value);
        progress(size);
      }
    } finally {
      await file.close();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (hash.digest('hex') !== artifact.sha256) throw new Error('Whisper checksum mismatch');
}

async function locate(dir: string): Promise<WhisperInstallation> {
  const model = join(dir, MODEL_NAME);
  const modelStat = await lstat(model);
  if (!modelStat.isFile() || modelStat.size === 0) throw new Error('Whisper model is missing');
  const runtime = join(dir, 'runtime');
  if (!(await lstat(runtime)).isDirectory()) throw new Error('Whisper runtime is missing');
  const entries = await readdir(runtime, { recursive: true, withFileTypes: true });
  const cli = entries.find((entry) => entry.isFile() && entry.name === CLI_NAME);
  if (cli === undefined) throw new Error('Whisper executable is missing');
  return { cli: join(cli.parentPath, cli.name), model };
}

function run(cli: string, args: string[], cwd: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd, signal, windowsHide: true, stdio: 'ignore' });
    let failure: Error | undefined;
    child.on('error', (error) => { failure = error; });
    child.once('close', (code) => {
      if (failure !== undefined) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error('Whisper exited unsuccessfully'));
    });
  });
}

export const whisperRuntime: WhisperRuntime = {
  locate,
  async install(dir, signal, progress) {
    const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
    const archive = join(dir, 'runtime.zip');
    const total = ARCHIVE.expectedBytes + MODEL.expectedBytes;
    const report = (received: number) => progress(Math.min(99, Math.floor(received * 100 / total)));
    await download(ARCHIVE, archive, downloadSignal, report);
    await download(MODEL, join(dir, MODEL_NAME), downloadSignal, (size) => report(ARCHIVE.expectedBytes + size));
    progress(100);
    signal.throwIfAborted();
    await extract(archive, {
      dir: join(dir, 'runtime'),
      onEntry(entry) {
        signal.throwIfAborted();
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) {
          throw new Error('Unexpected link in Whisper archive');
        }
      },
    });
    await rm(archive);
    const { cli } = await locate(dir);
    await run(cli, ['--help'], dir, AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
  },
  async transcribe({ cli, model }, dir, language, signal) {
    // Fixed, relative arguments keep user-profile characters out of the native CLI's argument parser.
    await run(cli, [
      '-m', relative(dir, model), '-f', 'input.wav', '-of', 'transcript', '-otxt', '-l', language,
      '-ng', '-np', '-t', String(Math.min(4, availableParallelism())),
    ], dir, signal);
    signal.throwIfAborted();
    const output = join(dir, 'transcript.txt');
    // The CLI skips creating the output file when it produces no segments.
    const info = await lstat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null) return '';
    if (!info.isFile() || info.size > 400_000) throw new Error('Invalid Whisper transcript');
    return (await readFile(output, 'utf8')).trim();
  },
};
