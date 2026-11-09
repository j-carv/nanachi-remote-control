import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { WhisperTranscriptSchema, type WhisperLanguage, type WhisperStatus, type WhisperTranscript } from '@nanachi/shared';
import { removeTree } from './accounts/profile-home.js';
import { ApiError } from './api-error.js';
import { whisperRuntime, type WhisperInstallation, type WhisperRuntime } from './whisper-runtime.js';
import { hasWhisperSamples } from './whisper-wav.js';

interface Job {
  controller: AbortController;
  done: Promise<unknown>;
}

async function entry(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function removeDirectory(path: string): Promise<void> {
  const info = await entry(path);
  if (info === undefined) return;
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unexpected entry in the Whisper data directory');
  await removeTree(path);
}

export class WhisperService {
  private readonly root: string;
  private readonly installed: string;
  private readonly staging: string;
  private readonly jobs: string;
  private readonly removalMarker: string;
  private state: WhisperStatus;
  private installation: WhisperInstallation | undefined;
  private maintenance: Job | undefined;
  private recording: Job | undefined;
  private closing = false;

  constructor(
    home: string,
    private readonly runtime: WhisperRuntime = whisperRuntime,
    private readonly supported = process.platform === 'win32' && process.arch === 'x64',
  ) {
    this.root = resolve(home, 'whisper');
    this.installed = join(this.root, 'installed');
    this.staging = join(this.root, 'staging');
    this.jobs = join(this.root, 'jobs');
    this.removalMarker = join(this.root, 'removal-pending');
    this.state = { state: supported ? 'disabled' : 'unsupported' };
  }

  status(): WhisperStatus {
    return this.state;
  }

  async initialize(): Promise<void> {
    if (!this.supported) return;
    try {
      const root = await entry(this.root);
      if (root === undefined) return;
      if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Invalid Whisper data directory');
      if (await entry(this.removalMarker) !== undefined) {
        this.state = { state: 'remove_failed' };
        this.remove();
        await this.maintenance?.done;
        return;
      }
      await removeDirectory(this.staging);
      await removeDirectory(this.jobs);
      const installed = await entry(this.installed);
      if (installed === undefined) return;
      if (installed.isSymbolicLink() || !installed.isDirectory()) throw new Error('Invalid Whisper installation directory');
      this.installation = await this.runtime.locate(this.installed);
      this.state = { state: 'ready' };
    } catch {
      this.state = { state: 'install_failed' };
    }
  }

  install(): WhisperStatus {
    this.requireAvailable();
    const { state } = this.state;
    if (state === 'ready' || state === 'installing') return this.state;
    if (state === 'removing' || state === 'remove_failed') {
      throw new ApiError(409, 'whisper_busy', 'Whisper removal must finish before installing');
    }
    this.state = { state: 'installing', progress: 0 };
    this.startMaintenance(async (signal) => {
      await this.ensureRoot();
      await removeDirectory(this.staging);
      await removeDirectory(this.jobs);
      await removeDirectory(this.installed);
      await mkdir(this.staging);
      try {
        await this.runtime.install(this.staging, signal, (progress) => {
          this.state = { state: 'installing', progress };
        });
        const staged = await this.runtime.locate(this.staging);
        signal.throwIfAborted();
        await rename(this.staging, this.installed);
        this.installation = {
          cli: join(this.installed, relative(this.staging, staged.cli)),
          model: join(this.installed, relative(this.staging, staged.model)),
        };
      } finally {
        await removeDirectory(this.staging);
      }
    }, 'ready', 'install_failed');
    return this.state;
  }

  remove(): WhisperStatus {
    this.requireAvailable();
    if (this.state.state === 'disabled' && this.maintenance === undefined) return this.state;
    if (this.state.state === 'removing') return this.state;
    if (this.state.state === 'installing') {
      throw new ApiError(409, 'whisper_busy', 'Whisper is installing');
    }
    this.state = { state: 'removing' };
    this.installation = undefined;
    const active = this.recording;
    active?.controller.abort();
    this.startMaintenance(async () => {
      await this.ensureRoot();
      const marker = await entry(this.removalMarker);
      if (marker === undefined) await writeFile(this.removalMarker, '', { flag: 'wx' });
      else if (!marker.isFile()) throw new Error('Invalid Whisper removal marker');
      await active?.done.catch(() => undefined);
      await removeDirectory(this.installed);
      await removeDirectory(this.staging);
      await removeDirectory(this.jobs);
      await rm(this.removalMarker);
    }, 'disabled', 'remove_failed');
    return this.state;
  }

  async transcribe(bytes: Buffer, language: WhisperLanguage, disconnected: AbortSignal): Promise<WhisperTranscript> {
    this.requireAvailable();
    const installation = this.installation;
    if (this.state.state !== 'ready' || installation === undefined) {
      throw new ApiError(409, 'whisper_not_ready', 'Whisper is not ready');
    }
    if (this.recording !== undefined) throw new ApiError(409, 'whisper_busy', 'Whisper is transcribing');
    if (!hasWhisperSamples(bytes)) throw new ApiError(422, 'whisper_no_speech', 'The recording is silent');
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(90_000);
    const signal = AbortSignal.any([controller.signal, timeout, disconnected]);
    const done = this.runTranscription(installation, bytes, language, signal);
    this.recording = { controller, done };
    try {
      return await done;
    } catch (error) {
      if (timeout.aborted) throw new ApiError(504, 'whisper_timeout', 'Whisper transcription timed out');
      if (signal.aborted) throw new ApiError(409, 'whisper_cancelled', 'Whisper transcription was cancelled');
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'whisper_transcription_failed', 'Whisper transcription failed');
    } finally {
      this.recording = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.maintenance?.controller.abort();
    this.recording?.controller.abort();
    await Promise.allSettled([this.maintenance?.done, this.recording?.done]);
  }

  private requireAvailable(): void {
    if (!this.supported) throw new ApiError(409, 'whisper_unsupported', 'Whisper requires Windows x64');
    if (this.closing) throw new ApiError(503, 'whisper_not_ready', 'The daemon is shutting down');
  }

  private async ensureRoot(): Promise<void> {
    const existing = await entry(this.root);
    if (existing === undefined) await mkdir(this.root);
    else if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('Invalid Whisper data directory');
  }

  private startMaintenance(
    action: (signal: AbortSignal) => Promise<void>,
    success: 'ready' | 'disabled',
    failure: 'install_failed' | 'remove_failed',
  ): void {
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => action(controller.signal))
      .then(
        () => {
          this.state = { state: success };
          this.maintenance = undefined;
        },
        () => {
          this.state = { state: failure };
          this.maintenance = undefined;
        },
      );
    this.maintenance = { controller, done };
  }

  private async runTranscription(
    installation: WhisperInstallation,
    bytes: Buffer,
    language: WhisperLanguage,
    signal: AbortSignal,
  ): Promise<WhisperTranscript> {
    signal.throwIfAborted();
    const jobs = await entry(this.jobs);
    if (jobs === undefined) await mkdir(this.jobs);
    else if (jobs.isSymbolicLink() || !jobs.isDirectory()) throw new Error('Invalid Whisper temporary directory');
    const dir = await mkdtemp(join(this.jobs, 'clip-'));
    try {
      await writeFile(join(dir, 'input.wav'), bytes, { flag: 'wx', signal });
      const text = (await this.runtime.transcribe(installation, dir, language, signal)).trim();
      signal.throwIfAborted();
      if (text === '') throw new ApiError(422, 'whisper_no_speech', 'No speech was recognized');
      return WhisperTranscriptSchema.parse({ text });
    } finally {
      await removeDirectory(dir);
    }
  }
}
