import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export interface RotatingLog {
  append(text: string): void;
  /** Last `count` non-empty lines of the current file (not the backup). */
  tail(count: number): string[];
}

export interface RotatingLogOptions {
  file: string;
  /** The file is renamed to `<file>.1` (replacing the old backup) when it has reached this size. */
  maxBytes: number;
}

/** Bytes read from the end of the file for `tail`: enough for dozens of daemon log lines. */
const TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * Size-rotated append-only log: one file plus one backup. Logging is best effort: a disk problem must not take
 * the tray down, so write errors are swallowed.
 */
export function createRotatingLog(options: RotatingLogOptions): RotatingLog {
  const { file, maxBytes } = options;

  function rotateIfFull(): void {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size < maxBytes) return;
    rmSync(`${file}.1`, { force: true });
    renameSync(file, `${file}.1`);
  }

  return {
    append(text) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        rotateIfFull();
        appendFileSync(file, text, 'utf8');
      } catch {
        // Best effort, see above.
      }
    },
    tail(count) {
      let fd: number | undefined;
      try {
        fd = openSync(file, 'r');
        const size = statSync(file).size;
        const length = Math.min(size, TAIL_WINDOW_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        const lines = buffer
          .toString('utf8')
          .split(/\r?\n/)
          .filter((line) => line.length > 0);
        return lines.slice(-count);
      } catch {
        return [];
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}
