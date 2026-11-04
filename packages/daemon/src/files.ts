import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileInfo } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { normalizeMime, sanitizeFileName } from './file-names.js';
import { insertFile, sessionFileUsage, type FileDirection, type FileRecord } from './repository.js';

/** Quantos arquivos uma sessão pode ter, somando os dois sentidos. */
export const SESSION_FILE_COUNT_LIMIT = 200;
/** Bytes de arquivos por sessão, somando os dois sentidos (500 MiB). */
export const SESSION_FILE_BYTES_LIMIT = 500 * 1024 * 1024;

/** Sessão estourou a cota de arquivos. Vira 413 `quota_exceeded`. */
export class FileQuotaError extends Error {
  constructor() {
    super('cota de arquivos da sessão excedida');
    this.name = 'FileQuotaError';
  }
}

/** `<NANACHI_HOME>/files`: uma subpasta por sessão. */
export function filesRootOf(home: string): string {
  return join(home, 'files');
}

export interface SaveFileInput {
  /** Pasta `<NANACHI_HOME>/files`, absoluta. */
  root: string;
  sessionId: string;
  direction: FileDirection;
  /** Nome como veio (cabeçalho X-File-Name, já decodificado). É sanitizado aqui. */
  rawName: string;
  /** Content-Type como veio. Parâmetros são descartados; ausente vira application/octet-stream. */
  rawMime: string | undefined;
  bytes: Buffer;
}

/** Registro e caminho do arquivo novo (ainda não gravado). */
function recordOf(input: SaveFileInput): { record: FileRecord; dir: string } {
  const id = randomUUID();
  const name = sanitizeFileName(input.rawName);
  const dir = join(input.root, input.sessionId);
  return {
    dir,
    record: {
      id,
      sessionId: input.sessionId,
      name,
      mime: normalizeMime(input.rawMime),
      size: input.bytes.length,
      direction: input.direction,
      path: join(dir, `${id}-${name}`),
      createdAt: Date.now(),
    },
  };
}

/** Cota conferida e linha inserida numa transação síncrona: não há await entre as duas. Estourou → FileQuotaError. */
function insertWithinQuota(db: Database.Database, record: FileRecord): void {
  db.transaction(() => {
    const usage = sessionFileUsage(db, record.sessionId);
    if (usage.count + 1 > SESSION_FILE_COUNT_LIMIT || usage.bytes + record.size > SESSION_FILE_BYTES_LIMIT) {
      throw new FileQuotaError();
    }
    insertFile(db, record);
  })();
}

/**
 * Grava `<root>/<sessionId>/<fileId>-<nome>` e a linha em `files`. Devolve o registro com o caminho absoluto.
 * A cota é conferida e a linha inserida na mesma transação síncrona (sem await entre as duas): dois envios
 * concorrentes não passam juntos do limite. Estourou → o arquivo recém-gravado é apagado e sai `FileQuotaError`.
 */
export async function saveFile(db: Database.Database, input: SaveFileInput): Promise<FileRecord> {
  const { dir, record } = recordOf(input);
  await mkdir(dir, { recursive: true });
  await writeFile(record.path, input.bytes, { flag: 'wx' });
  try {
    insertWithinQuota(db, record);
  } catch (error) {
    await rm(record.path, { force: true });
    throw error;
  }
  return record;
}

/**
 * Igual a `saveFile`, mas síncrono. Para o mapeamento de updates do ACP, que é síncrono e precisa manter a
 * ordem dos eventos: uma imagem gravada com await deixaria o texto seguinte passar na frente dela.
 */
export function saveFileSync(db: Database.Database, input: SaveFileInput): FileRecord {
  const { dir, record } = recordOf(input);
  mkdirSync(dir, { recursive: true });
  writeFileSync(record.path, input.bytes, { flag: 'wx' });
  try {
    insertWithinQuota(db, record);
  } catch (error) {
    rmSync(record.path, { force: true });
    throw error;
  }
  return record;
}

/**
 * Apaga `<root>/<sessionId>` de cada sessão (workspace apagado). Tolerante a erro: pasta ausente é ignorada e
 * falha de remoção (ex.: arquivo aberto por um processo no Windows) não impede o resto.
 */
export async function removeSessionFiles(root: string, sessionIds: readonly string[], onError: (error: unknown) => void): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      await rm(join(root, sessionId), { recursive: true, force: true });
    } catch (error) {
      onError(error);
    }
  }
}

/** Forma pública de um arquivo (o que vai no evento `user_message`, na resposta de upload e no `file`). */
export function toFileInfo(record: FileRecord): FileInfo {
  return { fileId: record.id, name: record.name, mime: record.mime, size: record.size };
}
