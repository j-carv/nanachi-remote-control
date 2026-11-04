import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import type { FileInfo } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { MAX_FILE_BYTES } from './file-names.js';
import { saveFileSync, toFileInfo } from './files.js';
import { resolveInsideRoots } from './roots.js';

/** Raster que o navegador mostra e que o PWA aceita: o mime define a extensão do arquivo salvo. */
const EXTENSION_BY_MIME: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** Imagem já lida: bytes, mime e extensão. */
interface ImageSource {
  mime: string;
  extension: string;
  bytes: Buffer;
}

/** Só vale se for raster aceito, não vazia e até o limite de arquivo do celular (50 MiB). */
function usable(mime: string, bytes: Buffer): ImageSource | undefined {
  const extension = EXTENSION_BY_MIME.get(mime);
  if (extension === undefined || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return undefined;
  return { mime, extension, bytes };
}

/** Imagem inline (base64) do próprio protocolo. */
function inlineSource(mime: string, data: string): ImageSource | undefined {
  return usable(mime, Buffer.from(data, 'base64'));
}

/**
 * Imagem em arquivo local: `file://` que cai dentro de uma das raízes permitidas (links e junctions resolvidos).
 * Qualquer outra coisa (outro esquema, fora das raízes, inexistente, grande demais) é ignorada sem lançar.
 */
function fileSource(uri: string, mime: string | null | undefined, roots: readonly string[]): ImageSource | undefined {
  if (mime === undefined || mime === null || !EXTENSION_BY_MIME.has(mime)) return undefined;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return undefined;
    const path = resolveInsideRoots(fileURLToPath(url), roots);
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    return usable(mime, readFileSync(path));
  } catch {
    return undefined;
  }
}

/** Bytes de um bloco do ACP que é imagem aceita; outros blocos (áudio, texto, recurso que não é imagem) → undefined. */
export function sourceOf(block: acp.ContentBlock, roots: readonly string[]): ImageSource | undefined {
  switch (block.type) {
    case 'image':
      return inlineSource(block.mimeType, block.data);
    case 'resource_link':
      return fileSource(block.uri, block.mimeType, roots);
    case 'resource':
      return fileSource(block.resource.uri, block.resource.mimeType, roots);
    default:
      return undefined;
  }
}

export interface AgentImagesDeps {
  db: Database.Database;
  /** `<NANACHI_HOME>/files`, absoluto. */
  filesRoot: string;
  /** `allowedRoots` do config: arquivo local só vale dentro delas. */
  allowedRoots: readonly string[];
  log: { warn(data: object, message: string): void };
}

/**
 * Imagens que o agente manda via ACP, gravadas como arquivos da sessão (direção to_phone, nome `imagem-<n>.<ext>`).
 * Dentro de uma sessão, o mesmo conteúdo (sha256) devolve o arquivo que já existe: a imagem reenviada num
 * tool_call_update não cria outro arquivo. Não avisa push: só o phone-send explícito avisa.
 */
export class AgentImages {
  /** sessionId → (sha256 do conteúdo → arquivo). Esquecido junto com a sessão. */
  private readonly bySession = new Map<string, Map<string, FileInfo>>();

  constructor(private readonly deps: AgentImagesDeps) {}

  /** Grava a imagem do bloco e devolve o arquivo. Undefined se o bloco não é imagem aceita ou não pôde ser gravado. */
  store(sessionId: string, block: acp.ContentBlock): FileInfo | undefined {
    const source = sourceOf(block, this.deps.allowedRoots);
    if (source === undefined) return undefined;

    const known = this.indexOf(sessionId);
    const hash = createHash('sha256').update(source.bytes).digest('hex');
    const existing = known.get(hash);
    if (existing !== undefined) return existing;

    const { db, filesRoot, log } = this.deps;
    try {
      const record = saveFileSync(db, {
        root: filesRoot,
        sessionId,
        direction: 'to_phone',
        rawName: `imagem-${known.size + 1}.${source.extension}`,
        rawMime: source.mime,
        bytes: source.bytes,
      });
      const info = toFileInfo(record);
      known.set(hash, info);
      return info;
    } catch (error) {
      log.warn({ err: error, sessionId }, 'imagem do agente não foi gravada');
      return undefined;
    }
  }

  forget(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  private indexOf(sessionId: string): Map<string, FileInfo> {
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new Map<string, FileInfo>();
    this.bySession.set(sessionId, created);
    return created;
  }
}
