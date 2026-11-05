import * as nodeFs from 'node:fs';
import { join, win32 } from 'node:path';
import { t } from '../common/i18n/index.js';
import { messageOf } from '../common/message.js';
import type { RootEntry } from '../common/control-api.js';

/**
 * Reads and writes `allowedRoots` in Desktop's own `config.json`, which is what the folder editor of the control center
 * edits. Only that key is ever touched: every other key (`port`, `allowedTailscaleLogins`, `agents`, ...) and the order
 * of the keys stay as they were. Paths are Windows paths; everything here uses `path.win32` explicitly.
 */

export type RootsConfigErrorCode = 'invalid_input' | 'io';

/** A failure with a message fit for the user, in Desktop's language. `invalid_input`: what was asked is wrong; `io`: the file is. */
export class RootsConfigError extends Error {
  readonly code: RootsConfigErrorCode;
  constructor(code: RootsConfigErrorCode, message: string) {
    super(message);
    this.name = 'RootsConfigError';
    this.code = code;
  }
}

export const MAX_ROOTS = 256;
export const MAX_ROOT_LENGTH = 1024;

/**
 * The part of `node:fs` the config file code uses; tests pass a fake for the failure cases. The config file is small and
 * lives in Desktop's own folder, so it is read and written synchronously; the paths the user lists can be anywhere (a
 * disconnected network drive, a share that is offline), so those are only ever looked at asynchronously (`stat`, `rename`).
 */
export type RootsConfigFs = Pick<typeof nodeFs, 'readFileSync' | 'writeFileSync' | 'rmSync'> & {
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
};

export const nodeRootsFs: RootsConfigFs = {
  readFileSync: nodeFs.readFileSync,
  writeFileSync: nodeFs.writeFileSync,
  rmSync: nodeFs.rmSync,
  rename: (from, to) => nodeFs.promises.rename(from, to),
  stat: (path) => nodeFs.promises.stat(path),
};

/** What a path is on disk right now. `timeout`: the place did not answer in time (an offline share), so nothing is known. */
export type PathKind = 'dir' | 'file' | 'missing' | 'timeout';
export type PathProbe = (path: string) => Promise<PathKind>;

/** How long one folder may take to answer before it is reported as `timeout`. */
export const PROBE_TIMEOUT_MS = 1_500;

/** Control characters and the characters Windows forbids in a path (the colon of a drive letter is checked apart). */
const INVALID_CHARACTERS = /[\u0000-\u001f<>"|?*]/;
const DRIVE_PATH = /^[A-Za-z]:\\/;
const UNC_PATH = /^\\\\[^\\]+\\[^\\]+/;

/**
 * One path in the form the list keeps: absolute, backslashes, `..` and `.` resolved, no trailing backslash except on a
 * drive root (`D:\`) or a network share root, drive letter in upper case, no `\\?\` prefix. Null when the text is not an
 * absolute path with a drive letter or a `\\server\share` (relative paths, `C:projetos`, `\projetos` and device paths
 * all depend on the current directory or are not folders, so they are refused).
 */
export function normalizeRoot(input: string): string | null {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(text)) text = `\\\\${text.slice(8)}`;
  else if (/^[\\/]{2}\?[\\/]/.test(text)) text = text.slice(4);
  if (text === '' || INVALID_CHARACTERS.test(text)) return null;
  text = text.replaceAll('/', '\\');

  const drive = DRIVE_PATH.test(text);
  const share = UNC_PATH.test(text) && !/^\\\\[.?]\\/.test(text);
  if (!drive && !share) return null;
  if (text.indexOf(':', drive ? 2 : 0) !== -1) return null;

  const resolved = win32.resolve(text);
  return resolved.replace(/^[a-z]:/, (letter) => letter.toUpperCase());
}

/** Case-insensitive identity of a normalized path (Windows paths are case-insensitive). */
function keyOf(path: string): string {
  return path.toLowerCase();
}

function withTrailingBackslash(path: string): string {
  return path.endsWith('\\') ? path : `${path}\\`;
}

/** True when `child` is `parent` or inside it. Both are normalized paths. */
export function containsPath(parent: string, child: string): boolean {
  const p = withTrailingBackslash(keyOf(parent));
  const c = withTrailingBackslash(keyOf(child));
  return c.startsWith(p);
}

function shorten(path: string): string {
  return path.length > 80 ? `${path.slice(0, 77)}...` : path;
}

/**
 * Turns what the editor sends into the list to save: normalized, duplicates removed without regard to case (the first
 * spelling wins, the order is kept). A path that is not absolute is refused. A path that is not on disk is refused too,
 * unless it was already in `previous` (a saved folder that went missing, or whose place does not answer, may stay in the
 * list). Every problem is reported in one error. The folders are looked at all at once, never one after another.
 */
export async function prepareRoots(input: readonly string[], previous: readonly string[], probe: PathProbe): Promise<string[]> {
  if (!Array.isArray(input) || input.some((item) => typeof item !== 'string')) {
    throw new RootsConfigError('invalid_input', t('main.roots.invalidList'));
  }
  if (input.length > MAX_ROOTS) {
    throw new RootsConfigError('invalid_input', t('main.roots.tooMany', { max: MAX_ROOTS }));
  }
  const known = new Set(previous.map((path) => keyOf(normalizeRoot(path) ?? path)));
  const problems: string[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const raw of input) {
    if (raw.length > MAX_ROOT_LENGTH) {
      problems.push(t('main.roots.pathTooLong', { path: shorten(raw) }));
      continue;
    }
    const path = normalizeRoot(raw);
    if (path === null) {
      problems.push(t('main.roots.notAbsolute', { path: shorten(raw) }));
      continue;
    }
    const key = keyOf(path);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(path);
  }

  const kinds = await Promise.all(candidates.map((path) => probe(path)));
  const result: string[] = [];
  candidates.forEach((path, index) => {
    const kind = kinds[index];
    const saved = known.has(keyOf(path));
    if (kind === 'file') {
      problems.push(t('main.roots.notFolder', { path }));
    } else if (kind === 'missing' && !saved) {
      problems.push(t('main.roots.missing', { path }));
    } else if (kind === 'timeout' && !saved) {
      problems.push(t('main.roots.timeout', { path }));
    } else {
      result.push(path);
    }
  });

  if (problems.length > 0) throw new RootsConfigError('invalid_input', problems.join(' '));
  return result;
}

/**
 * The entries as the editor shows them: flagged when the folder is gone (or its place does not answer), and with the
 * outermost entry that covers them.
 */
export async function describeRoots(roots: readonly string[], probe: PathProbe): Promise<RootEntry[]> {
  const kinds = await Promise.all(roots.map((path) => probe(path)));
  return roots.map((path, index) => {
    const key = keyOf(path);
    let outermost: string | null = null;
    for (const other of roots) {
      if (keyOf(other) === key || !containsPath(other, path)) continue;
      if (outermost === null || other.length < outermost.length) outermost = other;
    }
    return { path, exists: kinds[index] === 'dir', coveredBy: outermost };
  });
}

function readConfigObject(file: string, fs: RootsConfigFs): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new RootsConfigError('io', t('main.config.readFailed', { file, detail: messageOf(error) }));
  }
  let parsed: unknown;
  try {
    // PowerShell 5.1 writes a BOM; JSON.parse does not accept it.
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new RootsConfigError('io', t('main.config.invalidJson', { file, detail: messageOf(error) }));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RootsConfigError('io', t('main.config.notObject', { file }));
  }
  return parsed as Record<string, unknown>;
}

/** `allowedRoots` exactly as in the file: only string entries, empty when the key is missing or is not a list. */
export function readAllowedRoots(file: string, fs: RootsConfigFs = nodeRootsFs): string[] {
  const value = readConfigObject(file, fs).allowedRoots;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** What Windows answers while an antivirus, an indexer or OneDrive holds a file for a moment. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 4;
const RENAME_RETRY_DELAY_MS = 50;

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

export interface WriteOptions {
  /** Replaces the wait between two rename attempts; tests only. */
  sleep?: (ms: number) => Promise<void>;
}

/** The rename is retried a few times when the file is busy, with a wait that grows (50, 100, 150, 200 ms). */
async function renameWithRetry(fs: RootsConfigFs, from: string, to: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = codeOf(error);
      if (code === undefined || !BUSY_CODES.has(code) || tries >= RENAME_RETRIES) throw error;
      await sleep(RENAME_RETRY_DELAY_MS * (tries + 1));
    }
  }
}

/**
 * Replaces `allowedRoots` and nothing else: the file is parsed, the one key is set (in place, or last when it was
 * missing), and the object is written back as 2-space JSON plus a newline, UTF-8 without BOM. The write goes to a temp
 * file in the same folder and is renamed over the original (retried a few times while Windows holds the file), so a
 * crash never leaves half a file. A missing or unreadable file is never recreated here: a new one would lose the port
 * and the daemon would fall back to 7777.
 */
export async function writeAllowedRoots(
  file: string,
  roots: readonly string[],
  fs: RootsConfigFs = nodeRootsFs,
  options: WriteOptions = {},
): Promise<void> {
  const config = readConfigObject(file, fs);
  const next = { ...config, allowedRoots: [...roots] };
  const temp = `${file}.${process.pid}.tmp`;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await renameWithRetry(fs, temp, file, sleep);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Left behind; harmless.
    }
    throw new RootsConfigError('io', t('main.config.writeFailed', { file, detail: messageOf(error) }));
  }
}

/**
 * Looks at a path without ever blocking the main process: the lookup is asynchronous and raced against a timer, so a
 * disconnected network drive or an offline share costs `timeoutMs` and is reported as `timeout` instead of freezing
 * Desktop for as long as Windows takes to give up.
 */
function probeWith(fs: RootsConfigFs, timeoutMs: number): PathProbe {
  return async (path) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const looked = fs.stat(path).then(
      (stats): PathKind => (stats.isDirectory() ? 'dir' : 'file'),
      (): PathKind => 'missing',
    );
    try {
      return await Promise.race([looked, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface RootsStore {
  /** The saved `allowedRoots`, normalized for display (an entry that is not a usable path is shown as written). */
  read(): string[];
  /** Validates and writes the list; returns what was saved. Rejects with `RootsConfigError`. */
  save(input: readonly string[]): Promise<string[]>;
  describe(roots: readonly string[]): Promise<RootEntry[]>;
  /** What a path is on disk right now (never waits longer than the probe timeout). */
  probe: PathProbe;
}

export interface RootsStoreOptions {
  /** Desktop's data folder; its `config.json` is the file. */
  home: string;
  /** Creates `<home>/config.json` with Desktop's port when it does not exist (`ensureDesktopConfig`). */
  ensureConfig(home: string): void;
  fs?: RootsConfigFs;
  /** Replaces the disk lookup; tests only. */
  probe?: PathProbe;
  /** How long one folder may take to answer. Default 1.5 s. */
  probeTimeoutMs?: number;
}

export function createRootsStore(options: RootsStoreOptions): RootsStore {
  const fs = options.fs ?? nodeRootsFs;
  const probe = options.probe ?? probeWith(fs, options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  const file = join(options.home, 'config.json');

  function ensure(): void {
    try {
      options.ensureConfig(options.home);
    } catch (error) {
      throw new RootsConfigError('io', t('main.config.prepareFailed', { home: options.home, detail: messageOf(error) }));
    }
  }

  function read(): string[] {
    ensure();
    return readAllowedRoots(file, fs).map((path) => normalizeRoot(path) ?? path);
  }

  return {
    read,
    async save(input) {
      const previous = read();
      const roots = await prepareRoots(input, previous, probe);
      await writeAllowedRoots(file, roots, fs);
      return roots;
    },
    describe: (roots) => describeRoots(roots, probe),
    probe,
  };
}
