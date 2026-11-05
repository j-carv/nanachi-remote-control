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

/** The control center's "Logs" section: what it asks for and the most it ever gets. */
const LOGS_WINDOW_BYTES = 1024 * 1024;
const LOGS_MAX_LINES = 500;
const LOG_LINE_MAX_CHARS = 2000;
/** The prefix `tsnet-host.ts` gives every line it writes to the shared log. */
const TSNET_PREFIX = '[tsnet] ';

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function cleanLine(line: string): string {
  const text = line.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARACTERS, '');
  return text.length > LOG_LINE_MAX_CHARS ? `${text.slice(0, LOG_LINE_MAX_CHARS)}...` : text;
}

export interface ReadDesktopLogsOptions {
  /** Most lines kept in each list (the last ones). Default 500. */
  maxLines?: number;
  /** How much of the end of the file is read. Default 1 MiB. */
  windowBytes?: number;
}

/**
 * The last lines of Desktop's log (`desktop-daemon.log`), in two lists: the lines the Tailscale host wrote (`[tsnet] `)
 * and everything else (the daemon's own output and Desktop's `[desktop]` notes). The sidecar has no log file of its
 * own: its host writes into this one. Only the end of the file is read; a first line that the window cut in half is
 * dropped. Terminal escapes and control characters are removed and very long lines cut. A missing or unreadable file
 * gives two empty lists.
 */
export function readDesktopLogs(file: string, options: ReadDesktopLogsOptions = {}): { daemon: string[]; tailscale: string[] } {
  const maxLines = options.maxLines ?? LOGS_MAX_LINES;
  const windowBytes = options.windowBytes ?? LOGS_WINDOW_BYTES;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = statSync(file).size;
    const length = Math.min(size, windowBytes);
    const start = size - length;
    // One byte before the window tells whether it begins on a line boundary or in the middle of a line.
    const lead = start > 0 ? 1 : 0;
    const buffer = Buffer.alloc(length + lead);
    readSync(fd, buffer, 0, length + lead, start - lead);
    // With the lead byte, the first element is that byte's line: the tail of a line the window cut, or empty when the
    // window starts right after a newline. Either way it is not a line of the window.
    const lines = buffer.toString('utf8').split(/\r?\n/).slice(lead);
    const clean = lines.map(cleanLine).filter((line) => line !== '');
    const tailscale = clean.filter((line) => line.startsWith(TSNET_PREFIX));
    const daemon = clean.filter((line) => !line.startsWith(TSNET_PREFIX));
    return { daemon: daemon.slice(-maxLines), tailscale: tailscale.slice(-maxLines) };
  } catch {
    return { daemon: [], tailscale: [] };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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
