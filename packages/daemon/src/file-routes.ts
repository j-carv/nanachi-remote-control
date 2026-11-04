import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FileInfo } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { contentDisposition, MAX_FILE_BYTES, servedMimeOf } from './file-names.js';
import { saveFile, toFileInfo } from './files.js';
import { findFileById, findSessionById } from './repository.js';
import type { SessionManager } from './session-manager.js';

const CAPTION_MAX_CHARS = 1000;
/** Headers que o `tailscale serve` (ou outro proxy) acrescenta: a rota do agente só atende chamadas locais. */
const AGENT_PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'tailscale-user-login'] as const;
const FILE_CACHE_CONTROL = 'private, max-age=3600';

/** Autenticação de dispositivo (Bearer) como hook de rota: responde 401 e encerra quando não passa. */
export type DeviceGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

export interface FileRouteDeps {
  db: Database.Database;
  sessions: SessionManager;
  /** `<NANACHI_HOME>/files`, absoluto. */
  filesRoot: string;
  requireDevice: DeviceGuard;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Cabeçalho URI-encoded (X-File-Name, X-Caption). Sequência de escape inválida → undefined. */
function decodedHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Corpo cru de um upload. Vazio ou não-buffer → undefined (400). */
function rawBody(body: unknown): Buffer | undefined {
  return Buffer.isBuffer(body) && body.length > 0 ? body : undefined;
}

/** X-Caption opcional: URI-encoded, sem espaços nas pontas, até 1000 caracteres. */
function captionOf(request: FastifyRequest): { ok: true; caption: string | undefined } | { ok: false } {
  const raw = header(request, 'x-caption');
  if (raw === undefined) return { ok: true, caption: undefined };
  const text = decodedHeader(raw)?.trim();
  if (text === undefined || Array.from(text).length > CAPTION_MAX_CHARS) return { ok: false };
  return { ok: true, caption: text.length > 0 ? text : undefined };
}

/**
 * Parser cru para upload: troca os parsers herdados (JSON e texto) por um que devolve o Buffer. Assim um
 * arquivo `.json` ou `text/plain` não é interpretado, e o corpo chega inteiro até o limite da rota.
 */
function useRawBodies(instance: FastifyInstance): void {
  instance.removeAllContentTypeParsers();
  instance.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES }, (_request, body, done) => {
    done(null, body);
  });
}

/**
 * Rotas de arquivos: download (Bearer), anexo do celular (Bearer) e envio do agente (token de sessão).
 * Autenticação roda em onRequest, antes de ler o corpo: quem não passa não faz o daemon bufferizar 50 MiB.
 */
export async function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): Promise<void> {
  const { db, sessions, filesRoot, requireDevice } = deps;

  await app.register(async (downloads) => {
    downloads.addHook('onRequest', requireDevice);

    downloads.get<{ Params: { fileId: string } }>('/api/files/:fileId', async (request, reply) => {
      const record = findFileById(db, request.params.fileId);
      if (record === undefined) return reply.code(404).send({ error: 'not_found' });
      try {
        await stat(record.path);
      } catch {
        return reply.code(404).send({ error: 'not_found' });
      }

      reply
        .header('Content-Type', servedMimeOf(record.mime))
        .header('Content-Length', record.size)
        .header('Content-Disposition', contentDisposition(record.name, record.mime))
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', FILE_CACHE_CONTROL);
      return reply.send(createReadStream(record.path));
    });
  });

  await app.register(async (uploads) => {
    uploads.addHook('onRequest', requireDevice);
    useRawBodies(uploads);

    uploads.post<{ Params: { id: string } }>(
      '/api/sessions/:id/attachments',
      { bodyLimit: MAX_FILE_BYTES },
      async (request, reply) => {
        const sessionId = request.params.id;
        if (findSessionById(db, sessionId) === undefined) return reply.code(404).send({ error: 'not_found' });

        const name = decodedHeader(header(request, 'x-file-name'));
        const bytes = rawBody(request.body);
        if (name === undefined || name.length === 0 || bytes === undefined) {
          return reply.code(400).send({ error: 'invalid_request' });
        }

        const record = await saveFile(db, {
          root: filesRoot,
          sessionId,
          direction: 'from_phone',
          rawName: name,
          rawMime: header(request, 'content-type'),
          bytes,
        });
        const body: FileInfo = toFileInfo(record);
        return reply.code(201).send(body);
      },
    );
  });

  await app.register(async (agent) => {
    agent.addHook('onRequest', async (request, reply) => {
      // Chamada que passou por proxy (tailscale serve) não é do agente local: nada de rota do agente por aí.
      if (AGENT_PROXY_HEADERS.some((name) => request.headers[name] !== undefined)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      // Token antes de `isLive`: quem não tem o token não descobre se a sessão está viva.
      const sessionId = header(request, 'x-nanachi-session');
      if (sessionId === undefined || !sessions.verifyAgentToken(sessionId, header(request, 'x-nanachi-agent-token'))) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!sessions.isLive(sessionId)) return reply.code(403).send({ error: 'session_not_live' });
      return undefined;
    });
    useRawBodies(agent);

    agent.post('/api/agent/files', { bodyLimit: MAX_FILE_BYTES }, async (request, reply) => {
      const sessionId = header(request, 'x-nanachi-session') ?? '';
      const name = decodedHeader(header(request, 'x-file-name'));
      const caption = captionOf(request);
      const bytes = rawBody(request.body);
      if (name === undefined || name.length === 0 || bytes === undefined || !caption.ok) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const record = await saveFile(db, {
        root: filesRoot,
        sessionId,
        direction: 'to_phone',
        rawName: name,
        rawMime: header(request, 'content-type'),
        bytes,
      });
      const info = toFileInfo(record);
      sessions.recordFileToPhone(sessionId, info, caption.caption);
      const body: FileInfo = info;
      return reply.code(201).send(body);
    });
  });
}
