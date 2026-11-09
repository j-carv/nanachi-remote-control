import type { FastifyInstance } from 'fastify';
import type { DeviceGuard } from './file-routes.js';
import type { WhisperService } from './whisper.js';

export async function registerWhisperRoutes(
  app: FastifyInstance,
  whisper: WhisperService,
  requireDevice: DeviceGuard,
): Promise<void> {
  await app.register(async (api) => {
    api.addHook('onRequest', requireDevice);
    api.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });

    api.get('/api/whisper', async () => whisper.status());
    api.post('/api/whisper/install', async (_request, reply) => {
      const status = whisper.install();
      return reply.code(status.state === 'installing' ? 202 : 200).send(status);
    });
    api.delete('/api/whisper', async (_request, reply) => {
      const status = whisper.remove();
      return reply.code(status.state === 'removing' ? 202 : 200).send(status);
    });
  });
}
