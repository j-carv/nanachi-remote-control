import * as nodeFs from 'node:fs';
import { join } from 'node:path';

/**
 * The only way Desktop deletes a folder tree (installer, uninstaller, build scripts, test cleanup).
 *
 * Never `fs.rmSync(path, { recursive: true })`: under Electron's Node 24 it FOLLOWS directory junctions and deletes the
 * contents of their targets (Node 22, which vitest runs, does not, so a test of it passes and the app loses data).
 * `NANACHI_HOME\accounts\<agent>\<id>\{projects,skills,sessions,...}` are junctions into the user's `~/.claude` and
 * `~/.codex`, so "Apagar também os dados" through `rmSync` would wipe the user's Claude and Codex history.
 *
 * This walker looks at every entry with `lstat`: a symlink or junction is removed as a link and never entered, a file is
 * unlinked, a directory is emptied and then removed. `test/electron-runtime.test.ts` runs it under Electron's own Node.
 */

/** The part of `fs` the walker uses. `original-fs` (the uninstaller inside Electron) satisfies it too. */
export type RemoveFs = Pick<typeof nodeFs, 'chmodSync' | 'lstatSync' | 'readdirSync' | 'rmdirSync' | 'unlinkSync'>;

export interface RemoveOptions {
  /** Extra attempts after the first one for an entry that is busy or not empty yet. Default 3. */
  retries?: number;
  /** Wait before retry n is `n * retryDelayMs`. Default 200. */
  retryDelayMs?: number;
  /** Blocking wait between attempts (tests replace it). */
  sleep?: (ms: number) => void;
}

interface Settings {
  retries: number;
  retryDelayMs: number;
  sleep: (ms: number) => void;
}

/** What Windows answers while an antivirus, an indexer or a running exe holds a file, or a read-only bit is set. */
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const DENIED = new Set(['EPERM', 'EACCES']);

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** Runs `run` until it works. `ENOENT` counts as done (already gone). False when it never worked. */
function attempt(run: () => void, settings: Settings, onDenied?: () => void): boolean {
  for (let tries = 0; ; tries += 1) {
    try {
      run();
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return true;
      if (code === undefined || !RETRYABLE.has(code) || tries >= settings.retries) return false;
      if (DENIED.has(code)) onDenied?.();
      settings.sleep(settings.retryDelayMs * (tries + 1));
    }
  }
}

function removeFile(path: string, fs: RemoveFs, settings: Settings): boolean {
  return attempt(
    () => fs.unlinkSync(path),
    settings,
    () => {
      // A read-only file: clear the bit and let the next attempt delete it.
      try {
        fs.chmodSync(path, 0o666);
      } catch {
        // Whatever stops the delete is reported by the next attempt.
      }
    },
  );
}

/** A symlink or a junction goes as a link: `unlink` removes it on Windows (and POSIX), `rmdir` is the fallback. */
function removeLink(path: string, fs: RemoveFs, settings: Settings): boolean {
  return attempt(() => {
    try {
      fs.unlinkSync(path);
    } catch (unlinkError) {
      if (errorCode(unlinkError) === 'ENOENT') return;
      // `rmdirSync` is not recursive: on a link (or an empty folder) it removes just that, never the target's contents.
      try {
        fs.rmdirSync(path);
      } catch {
        throw unlinkError;
      }
    }
  }, settings);
}

function removeDirectory(path: string, fs: RemoveFs, settings: Settings): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
  let clean = true;
  for (const name of names) {
    if (!removeEntry(join(path, name), fs, settings)) clean = false;
  }
  // Something inside stayed (held by a process): the folder cannot go, and waiting will not change that.
  if (!clean) return false;
  return attempt(() => fs.rmdirSync(path), settings);
}

function removeEntry(path: string, fs: RemoveFs, settings: Settings): boolean {
  let stats: nodeFs.Stats;
  try {
    stats = fs.lstatSync(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
  // The link check comes first: on Windows a junction is a link that also carries the directory attribute.
  if (stats.isSymbolicLink()) return removeLink(path, fs, settings);
  if (stats.isDirectory()) return removeDirectory(path, fs, settings);
  return removeFile(path, fs, settings);
}

/**
 * Deletes `path` and everything below it without ever following a link. Entries that cannot be deleted (a file a
 * running process holds) are left and make the result false, but the rest is still removed. True when `path` is gone.
 */
export function removeTree(path: string, fs: RemoveFs = nodeFs, options: RemoveOptions = {}): boolean {
  return removeEntry(path, fs, {
    retries: options.retries ?? 3,
    retryDelayMs: options.retryDelayMs ?? 200,
    sleep: options.sleep ?? sleepSync,
  });
}

/** `removeTree`, but a folder that could not be removed is an error (build scripts must not go on over leftovers). */
export function removeTreeOrThrow(path: string, fs: RemoveFs = nodeFs, options: RemoveOptions = {}): void {
  if (!removeTree(path, fs, options)) throw new Error(`não foi possível remover ${path}`);
}
