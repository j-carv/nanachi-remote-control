import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  WorkspaceEntriesResponse,
  WorkspaceEntryType,
  WorkspaceFileResponse,
  WorkspaceFileWriteResponse,
} from '@nanachi/shared';
import { ApiError } from './api-error.js';
import { checkIgnored, isGitRepo } from './git.js';
import { isInside } from './roots.js';
import { resolveEntry, resolveExisting, type ResolvedPath } from './workspace-paths.js';

/** Largest text file the editor reads or writes (2 MiB). */
export const TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** How many leading bytes are scanned for a NUL to classify a file as binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Strict UTF-8. `ignoreBOM: true` keeps a byte order mark in the text, so a write puts it back in the file. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Content version: SHA-256 in hex. Changes with any byte, line endings included. */
export function etagOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Runs a disk operation and maps path errors (ENOENT, EEXIST...) to ApiError. Other errors pass through unchanged. */
async function mappingDiskErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toApiError(error);
  }
}

/** Maps a disk error to an ApiError. An error with no mapping is returned as-is (it becomes a 500). */
function toApiError(error: unknown): unknown {
  if (error instanceof ApiError) return error;
  switch (errorCode(error)) {
    case 'ENOENT':
      return new ApiError(404, 'not_found', 'path not found');
    case 'EEXIST':
      return new ApiError(409, 'already_exists', 'an item with this name already exists');
    case 'ENOTDIR':
      return new ApiError(400, 'not_a_directory', 'path is not a folder');
    case 'EISDIR':
      return new ApiError(400, 'not_a_file', 'path is not a file');
    case 'ENOTEMPTY':
      return new ApiError(409, 'dir_not_empty', 'the folder is not empty');
    default:
      return error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Target of a change: the workspace root cannot be created, renamed or deleted, so it is refused here. */
function entryTarget(realRoot: string, input: string): ResolvedPath {
  const target = resolveEntry(realRoot, input);
  if (target.rel === '') throw new ApiError(400, 'invalid_path', 'the workspace root cannot be changed');
  return target;
}

function typeOf(info: { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }): WorkspaceEntryType | undefined {
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'dir';
  if (info.isFile()) return 'file';
  return undefined;
}

/**
 * Folders first, then files, each group sorted by name. A link is listed as `symlink` and never followed.
 * `.git` is left out. `ignored` comes from one batched `git check-ignore` call when the workspace is a repository.
 */
export async function listDirectory(realRoot: string, input: string): Promise<WorkspaceEntriesResponse> {
  return mappingDiskErrors(async () => {
    const dir = resolveExisting(realRoot, input);
    if (!(await stat(dir.abs)).isDirectory()) {
      throw new ApiError(400, 'not_a_directory', 'path is not a folder');
    }

    const names = (await readdir(dir.abs)).filter((name) => name !== '.git');
    const rows = await Promise.all(
      names.map(async (name) => {
        const info = await lstat(join(dir.abs, name)).catch(() => undefined);
        const type = info === undefined ? undefined : typeOf(info);
        if (info === undefined || type === undefined) return undefined;
        return {
          name,
          type,
          size: info.size,
          mtimeMs: info.mtimeMs,
          rel: dir.rel === '' ? name : `${dir.rel}/${name}`,
        };
      }),
    );
    const found = rows.filter((row): row is NonNullable<typeof row> => row !== undefined);

    const ignored = (await isGitRepo(realRoot))
      ? await checkIgnored(realRoot, found.map((row) => row.rel))
      : new Set<string>();

    const entries = found.map((row) => ({
      name: row.name,
      type: row.type,
      size: row.size,
      mtimeMs: row.mtimeMs,
      ignored: ignored.has(row.rel),
    }));
    entries.sort(
      (a, b) =>
        (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
        a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }),
    );
    return { entries };
  });
}

interface LoadedText {
  bytes: Buffer;
  text: string;
  mtimeMs: number;
}

/** Decodes as text or refuses: a NUL in the sniff window, or bytes that are not valid UTF-8, → 415. */
function decodeText(bytes: Buffer): string {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    throw new ApiError(415, 'binary_file', 'binary file: the editor cannot open it');
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new ApiError(415, 'binary_file', 'file is not UTF-8: the editor cannot open it');
  }
}

/** Reads a file that is already resolved inside the workspace. Checks type and size before and after the read. */
async function loadText(abs: string): Promise<LoadedText> {
  return mappingDiskErrors(async () => {
    const info = await stat(abs);
    if (!info.isFile()) throw new ApiError(400, 'not_a_file', 'path is not a file');
    if (info.size > TEXT_MAX_BYTES) throw new ApiError(413, 'file_too_large', 'file is larger than 2 MiB');
    const bytes = await readFile(abs);
    if (bytes.length > TEXT_MAX_BYTES) throw new ApiError(413, 'file_too_large', 'file is larger than 2 MiB');
    return { bytes, text: decodeText(bytes), mtimeMs: info.mtimeMs };
  });
}

/** Text read: the content as stored (line endings and BOM included) plus its etag. */
export async function readTextFile(realRoot: string, input: string): Promise<WorkspaceFileResponse> {
  const target = resolveExisting(realRoot, input);
  const loaded = await loadText(target.abs);
  return {
    path: target.rel,
    content: loaded.text,
    encoding: 'utf8',
    size: loaded.bytes.length,
    mtimeMs: loaded.mtimeMs,
    etag: etagOf(loaded.bytes),
  };
}

/**
 * Bytes to write over an existing file: the line ending follows the original. CRLF when the original has more CRLF
 * than bare LF, LF otherwise. The incoming content may use either.
 */
function encodeWithLineEndingsOf(content: string, original: string): Buffer {
  const normalized = content.replace(/\r\n/g, '\n');
  const crlf = (original.match(/\r\n/g) ?? []).length;
  const bareLf = (original.match(/\n/g) ?? []).length - crlf;
  const converted = crlf > bareLf ? normalized.replace(/\n/g, '\r\n') : normalized;
  return Buffer.from(converted, 'utf8');
}

/**
 * Writes to a temporary file in the same folder, then renames it over the target, so a reader never sees a half-written
 * file. If the write fails, the temporary file is removed.
 */
async function replaceFile(abs: string, bytes: Buffer): Promise<void> {
  const temp = join(dirname(abs), `.${basename(abs)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, abs);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw toApiError(error);
  }
}

interface Written {
  rel: string;
  abs: string;
  bytes: Buffer;
}

/** Create: the name is claimed with `wx` before writing, so two creates for the same name cannot overwrite each other. */
async function createFile(realRoot: string, input: string, content: string): Promise<Written> {
  const target = entryTarget(realRoot, input);
  const bytes = Buffer.from(content, 'utf8');
  try {
    const handle = await open(target.abs, 'wx');
    await handle.close();
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new ApiError(409, 'file_exists', 'file already exists');
    throw toApiError(error);
  }
  try {
    await replaceFile(target.abs, bytes);
  } catch (error) {
    await rm(target.abs, { force: true }).catch(() => undefined);
    throw error;
  }
  return { ...target, bytes };
}

/** Update: writes only when the current content still has the etag the client read. */
async function updateFile(realRoot: string, input: string, content: string, baseEtag: string): Promise<Written> {
  const target = resolveExisting(realRoot, input);
  if (target.rel === '') throw new ApiError(400, 'not_a_file', 'path is not a file');
  const current = await loadText(target.abs);
  const currentEtag = etagOf(current.bytes);
  if (currentEtag !== baseEtag) {
    throw new ApiError(409, 'file_changed', 'file changed since it was read', { etag: currentEtag });
  }
  const bytes = encodeWithLineEndingsOf(content, current.text);
  if (bytes.length > TEXT_MAX_BYTES) throw new ApiError(413, 'file_too_large', 'file is larger than 2 MiB');
  await replaceFile(target.abs, bytes);
  return { ...target, bytes };
}

/**
 * Text write. `baseEtag: null` creates (409 `file_exists` if it already exists). An etag updates (409 `file_changed`
 * with the current etag if the file changed). Content over 2 MiB → 413, before anything touches the disk.
 */
export async function writeTextFile(
  realRoot: string,
  input: string,
  content: string,
  baseEtag: string | null,
): Promise<WorkspaceFileWriteResponse> {
  if (Buffer.byteLength(content, 'utf8') > TEXT_MAX_BYTES) {
    throw new ApiError(413, 'file_too_large', 'file is larger than 2 MiB');
  }
  const written = baseEtag === null
    ? await createFile(realRoot, input, content)
    : await updateFile(realRoot, input, content, baseEtag);
  const info = await mappingDiskErrors(() => stat(written.abs));
  return {
    path: written.rel,
    size: written.bytes.length,
    mtimeMs: info.mtimeMs,
    etag: etagOf(written.bytes),
  };
}

/** Creates one folder (not recursive). Already exists → 409 `already_exists`; missing parent → 404. */
export async function makeDirectory(realRoot: string, input: string): Promise<{ path: string }> {
  const target = entryTarget(realRoot, input);
  try {
    await mkdir(target.abs);
  } catch (error) {
    throw toApiError(error);
  }
  return { path: target.rel };
}

async function exists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Renames or moves a file or folder inside the workspace. An existing destination → 409 `already_exists`, except a
 * case-only change of the same name (on Windows `a.md` and `A.md` are the same file). Moving a folder into itself → 400.
 */
export async function renameEntry(
  realRoot: string,
  fromInput: string,
  toInput: string,
): Promise<{ from: string; to: string }> {
  const from = entryTarget(realRoot, fromInput);
  const to = entryTarget(realRoot, toInput);
  if (from.rel === to.rel) throw new ApiError(400, 'invalid_path', 'source and destination are the same path');
  // Strictly longer and inside: a folder moved below itself. Same length (a case-only rename) is not a move.
  if (to.abs.length > from.abs.length && isInside(to.abs, from.abs)) {
    throw new ApiError(400, 'invalid_path', 'a folder cannot be moved into itself');
  }
  await mappingDiskErrors(() => lstat(from.abs));

  const caseOnly =
    dirname(from.abs).toLowerCase() === dirname(to.abs).toLowerCase() &&
    basename(from.abs).toLowerCase() === basename(to.abs).toLowerCase();
  if (!caseOnly && (await exists(to.abs))) {
    throw new ApiError(409, 'already_exists', 'an item with this name already exists');
  }
  await mappingDiskErrors(() => rename(from.abs, to.abs));
  return { from: from.rel, to: to.rel };
}

/** Removes a link (symlink or junction) without touching its target. A linked folder on Windows needs `rmdir`. */
async function removeLink(abs: string): Promise<void> {
  try {
    await unlink(abs);
  } catch (error) {
    if (errorCode(error) === 'EPERM' || errorCode(error) === 'EISDIR') {
      await rmdir(abs);
      return;
    }
    throw error;
  }
}

/**
 * Deletes a file, a link, or an empty folder. Never recursive: a folder with content → 409 `dir_not_empty`.
 * A link is deleted as a link: its target, even inside the workspace, stays intact.
 */
export async function deleteEntry(realRoot: string, input: string): Promise<void> {
  const target = entryTarget(realRoot, input);
  try {
    const info = await lstat(target.abs);
    if (info.isSymbolicLink()) {
      await removeLink(target.abs);
    } else if (info.isDirectory()) {
      if ((await readdir(target.abs)).length > 0) {
        throw new ApiError(409, 'dir_not_empty', 'the folder is not empty');
      }
      await rmdir(target.abs);
    } else {
      await unlink(target.abs);
    }
  } catch (error) {
    throw toApiError(error);
  }
}
