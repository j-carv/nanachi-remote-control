import type { Readable } from 'node:stream';
import { TranscriptionLanguageSchema, UpdateTranscriptionSettingsSchema, WHISPER_MAX_WAV_BYTES } from '@nanachi/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './api-error.js';
import type { DeviceGuard } from './file-routes.js';
import type { TranscriptionSettingsService } from './transcription-settings.js';
import type { TranscriptionRecording, TranscriptionService } from './transcription.js';

export async function registerTranscriptionRoutes(
  app: FastifyInstance,
  service: TranscriptionService,
  settings: TranscriptionSettingsService,
  requireDevice: DeviceGuard,
): Promise<void> {
  await app.register(async (api) => {
    const uploads = new WeakMap<FastifyRequest, { recording: TranscriptionRecording; cleanup(): void }>();
    api.addHook('onRequest', requireDevice);
    api.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
    api.addHook('onError', async (request) => { uploads.get(request)?.cleanup(); });
    api.addHook('onResponse', async (request) => { uploads.get(request)?.cleanup(); });
    api.addContentTypeParser('audio/wav', async (request: FastifyRequest, payload: Readable) => {
      const upload = uploads.get(request);
      if (upload === undefined) throw new ApiError(400, 'transcription_invalid_audio', 'Unexpected audio body.');
      const { signal } = upload.recording;
      const cancel = (): void => { payload.destroy(signal.reason instanceof ApiError ? signal.reason : new ApiError(409, 'transcription_cancelled', 'Recording upload was cancelled.')); };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      let size = 0;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of payload) {
          signal.throwIfAborted();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > WHISPER_MAX_WAV_BYTES) throw new ApiError(413, 'too_large', 'Recording exceeded the size limit.');
          chunks.push(bytes);
        }
        signal.throwIfAborted();
        return Buffer.concat(chunks, size);
      } catch (error) {
        if (signal.aborted) throw signal.reason instanceof ApiError ? signal.reason : new ApiError(409, 'transcription_cancelled', 'Recording upload was cancelled.');
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    });

    api.get('/api/transcription/settings', async () => settings.get());
    api.put('/api/transcription/settings', async (request) => {
      const parsed = UpdateTranscriptionSettingsSchema.safeParse(request.body);
      if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Invalid transcription settings.');
      return settings.update(parsed.data);
    });
    api.get('/api/transcription/status', async () => service.status());
    api.get('/api/transcription/models', async (request, reply) => {
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      request.raw.once('aborted', cancel);
      reply.raw.once('close', cancel);
      if (request.raw.aborted || reply.raw.destroyed) cancel();
      try {
        return await service.models(controller.signal);
      } finally {
        request.raw.off('aborted', cancel);
        reply.raw.off('close', cancel);
      }
    });
    api.post<{ Querystring: { language?: unknown } }>(
      '/api/transcription/transcribe',
      {
        bodyLimit: WHISPER_MAX_WAV_BYTES,
        onRequest: async (request, reply) => {
          if (!TranscriptionLanguageSchema.safeParse(request.query.language).success) {
            throw new ApiError(400, 'transcription_invalid_audio', 'A supported transcription language is required.');
          }
          const controller = new AbortController();
          const recording = service.begin(controller.signal);
          const cancel = (): void => controller.abort();
          request.raw.once('aborted', cancel);
          reply.raw.once('close', cancel);
          uploads.set(request, {
            recording,
            cleanup: () => {
              recording.close();
              request.raw.off('aborted', cancel);
              reply.raw.off('close', cancel);
              uploads.delete(request);
            },
          });
          if (request.raw.aborted || reply.raw.destroyed) cancel();
        },
      },
      async (request) => {
        const upload = uploads.get(request);
        if (upload === undefined) throw new ApiError(409, 'transcription_cancelled', 'The recording is no longer active.');
        try {
          return await upload.recording.transcribe(request.body, request.query.language);
        } finally {
          upload.cleanup();
        }
      },
    );
  });
}
