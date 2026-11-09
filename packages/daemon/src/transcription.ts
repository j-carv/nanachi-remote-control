import {
  TranscriptionLanguageSchema, TranscriptionModelSchema, TranscriptionResultSchema,
  type TranscriptionLanguage, type TranscriptionModel, type TranscriptionModelsResponse,
  type TranscriptionResult, type TranscriptionSettings, type TranscriptionStatus,
} from '@nanachi/shared';
import { ApiError } from './api-error.js';
import type { TranscriptionSettingsService } from './transcription-settings.js';
import type { WhisperService } from './whisper.js';
import { hasWhisperSamples, isWhisperWav } from './whisper-wav.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const PRESETS: Record<'whisper' | 'openai' | 'groq', readonly TranscriptionModel[]> = {
  whisper: [{ id: 'ggml-base-q5_1.bin', name: 'Whisper Base Q5_1 (local)', provider: 'whisper' }],
  openai: [
    { id: 'gpt-transcribe', name: 'GPT Transcribe', provider: 'openai' },
    { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe (legacy)', provider: 'openai', deprecated: true },
    { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe (legacy)', provider: 'openai', deprecated: true },
  ],
  groq: [
    { id: 'whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo', provider: 'groq' },
    { id: 'whisper-large-v3', name: 'Whisper Large v3', provider: 'groq' },
  ],
};

function failure(): ApiError {
  return new ApiError(502, 'transcription_failed', 'Transcription provider request failed.');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Operation {
  controller: AbortController;
  signal: AbortSignal;
  timedOut: boolean;
  timer: NodeJS.Timeout;
  done: Promise<void>;
  finish(): void;
}

/** Reserved before reading the upload, so the deadline and single-clip guard include body reading. */
export interface TranscriptionRecording {
  readonly signal: AbortSignal;
  transcribe(bytes: unknown, language: unknown): Promise<TranscriptionResult>;
  close(): void;
}

/** A single selected source, never a fallback chain. Native installation remains WhisperService's concern. */
export class TranscriptionService {
  private readonly operations = new Set<Operation>();
  private recording: Operation | undefined;
  private closing = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly settings: TranscriptionSettingsService, private readonly whisper: WhisperService) {
    this.unsubscribe = settings.onChange(() => {
      for (const operation of this.operations) operation.controller.abort();
    });
  }

  status(): TranscriptionStatus {
    const { settings, apiKey } = this.settings.connection();
    let state: TranscriptionStatus['state'];
    if (this.closing) state = 'not_ready';
    else if (this.recording !== undefined) state = 'busy';
    else if (settings.provider === 'whisper') {
      const local = this.whisper.status().state;
      state = local === 'ready' ? 'ready' : local === 'unsupported' ? 'unsupported' : 'not_ready';
    } else if (settings.model === '' || settings.baseUrl === ''
      || (settings.provider !== 'custom' && apiKey === undefined)) state = 'configuration_required';
    else state = 'ready';
    return { provider: settings.provider, model: settings.model, state };
  }

  begin(disconnected: AbortSignal): TranscriptionRecording {
    const status = this.status();
    if (status.state === 'busy') throw new ApiError(409, 'transcription_busy', 'A recording is already active.');
    if (status.state === 'unsupported') throw new ApiError(409, 'transcription_unsupported', 'Local transcription is unsupported.');
    if (status.state !== 'ready') throw new ApiError(409, 'transcription_not_ready', 'The selected transcription provider is not ready.');
    const connection = this.settings.connection();
    const operation = this.operation(disconnected, connection.settings.timeoutMs);
    this.recording = operation;
    let started = false;
    return {
      signal: operation.signal,
      transcribe: async (bytes, language) => {
        if (started) throw new ApiError(409, 'transcription_busy', 'This recording is already being transcribed.');
        started = true;
        try {
          operation.signal.throwIfAborted();
          const parsedLanguage = TranscriptionLanguageSchema.safeParse(language);
          if (!parsedLanguage.success || !isWhisperWav(bytes)) {
            throw new ApiError(400, 'transcription_invalid_audio', 'Expected mono 16 kHz PCM WAV and a supported language.');
          }
          if (!hasWhisperSamples(bytes)) throw new ApiError(422, 'transcription_no_speech', 'The recording is silent.');
          const result = connection.settings.provider === 'whisper'
            ? await this.whisper.transcribe(bytes, parsedLanguage.data, operation.signal)
            : await this.remote(bytes, parsedLanguage.data, connection.settings, connection.apiKey, operation.signal);
          // Settings changes invalidate even a provider/runtime that completes after ignoring its abort signal.
          operation.signal.throwIfAborted();
          return TranscriptionResultSchema.parse(result);
        } catch (error) {
          throw this.error(error, operation);
        } finally {
          operation.finish();
        }
      },
      close: () => { operation.controller.abort(); if (!started) operation.finish(); },
    };
  }

  async transcribe(bytes: unknown, language: TranscriptionLanguage, disconnected: AbortSignal): Promise<TranscriptionResult> {
    return this.begin(disconnected).transcribe(bytes, language);
  }

  async models(disconnected: AbortSignal): Promise<TranscriptionModelsResponse> {
    if (this.closing) throw new ApiError(409, 'transcription_not_ready', 'The daemon is shutting down.');
    const { settings, apiKey } = this.settings.connection();
    if (settings.provider !== 'custom') return { models: PRESETS[settings.provider].map((model) => ({ ...model })), manual: false };
    const selected = settings.model === '' ? [] : [{ id: settings.model, name: settings.model, provider: 'custom' as const }];
    if (settings.baseUrl === '') return { models: selected, manual: true };
    const operation = this.operation(disconnected, Math.min(30_000, settings.timeoutMs));
    try {
      const payload = await this.request(settings.baseUrl, '/models', apiKey, operation.signal);
      operation.signal.throwIfAborted();
      if (payload === undefined) return { models: selected, manual: true };
      if (!record(payload) || !Array.isArray(payload.data) || payload.data.length > 1000) throw failure();
      const models: TranscriptionModel[] = [...selected];
      const seen = new Set(selected.map((model) => model.id));
      for (const row of payload.data) {
        if (!record(row)) throw failure();
        // A generic OpenAI catalog often contains chat models; listing alone is not evidence of STT support.
        const tasks = [row.task, ...(Array.isArray(row.tasks) ? row.tasks : []), ...(Array.isArray(row.capabilities) ? row.capabilities : [])];
        const speech = tasks.some((task) => task === 'transcription' || task === 'speech-to-text' || task === 'automatic-speech-recognition')
          || (record(row.capabilities) && row.capabilities.transcription === true);
        if (!speech) continue;
        const parsed = TranscriptionModelSchema.safeParse({ id: row.id, name: row.name ?? row.id, provider: 'custom' });
        if (!parsed.success) throw failure();
        if (!seen.has(parsed.data.id)) {
          if (models.length >= 1000) throw failure();
          seen.add(parsed.data.id);
          models.push(parsed.data);
        }
      }
      return { models, manual: true };
    } catch (error) {
      throw this.error(error, operation);
    } finally {
      operation.finish();
    }
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.unsubscribe();
    const operations = [...this.operations];
    for (const operation of operations) operation.controller.abort();
    await Promise.allSettled(operations.map((operation) => operation.done));
  }

  private operation(disconnected: AbortSignal, timeoutMs: number): Operation {
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const operation: Operation = {
      controller, signal: AbortSignal.any([controller.signal, disconnected]), timedOut: false, done,
      timer: setTimeout(() => {
        operation.timedOut = true;
        controller.abort(new ApiError(504, 'transcription_timeout', 'Recording exceeded its time limit.'));
      }, timeoutMs),
      finish: () => {
        clearTimeout(operation.timer);
        this.operations.delete(operation);
        if (this.recording === operation) this.recording = undefined;
        finish();
      },
    };
    operation.timer.unref();
    this.operations.add(operation);
    return operation;
  }

  private error(error: unknown, operation: Operation): ApiError {
    if (operation.timedOut) return new ApiError(504, 'transcription_timeout', 'Transcription exceeded its time limit.');
    if (operation.signal.aborted) return new ApiError(409, 'transcription_cancelled', 'Transcription was cancelled.');
    if (error instanceof ApiError) {
      if (error.code.startsWith('transcription_')) return error;
      const code = error.code === 'whisper_transcription_failed' ? 'transcription_failed'
        : error.code.startsWith('whisper_') ? error.code.replace(/^whisper_/u, 'transcription_') : undefined;
      if (code !== undefined) return new ApiError(error.status, code, 'Local transcription failed.');
    }
    return failure();
  }

  private async remote(bytes: Buffer, language: TranscriptionLanguage, settings: TranscriptionSettings, key: string | undefined, signal: AbortSignal): Promise<TranscriptionResult> {
    const body = new FormData();
    body.append('file', new Blob([new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)], { type: 'audio/wav' }), 'recording.wav');
    body.append('model', settings.model);
    body.append('response_format', 'json');
    body.append('language', language);
    const payload = await this.request(settings.baseUrl, '/audio/transcriptions', key, signal, body);
    if (record(payload) && typeof payload.text === 'string' && payload.text.trim() === '') {
      throw new ApiError(422, 'transcription_no_speech', 'No speech was recognized.');
    }
    const parsed = TranscriptionResultSchema.safeParse(payload);
    if (!parsed.success) throw failure();
    return parsed.data;
  }

  private async request(baseUrl: string, path: string, key: string | undefined, signal: AbortSignal, body?: FormData): Promise<unknown> {
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await fetch(`${baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        headers: { Accept: 'application/json', ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }) },
        ...(body === undefined ? {} : { body }),
      });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw failure();
      if (!response.ok) {
        if (body === undefined && [404, 405, 501].includes(response.status)) return undefined;
        throw failure();
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw failure();
      if (response.body === null) throw failure();
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let size = 0;
      let text = '';
      try {
        for (;;) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw failure();
          text += decoder.decode(chunk.value, { stream: true });
        }
        signal.throwIfAborted();
        text += decoder.decode();
      } finally {
        try { await reader.cancel(); } catch { /* Provider diagnostics and abort reasons remain private. */ }
        reader.releaseLock();
      }
      return JSON.parse(text) as unknown;
    } catch {
      throw failure();
    } finally {
      try { await response?.body?.cancel(); } catch { /* Never expose transport exceptions or provider bodies. */ }
    }
  }
}
