import type { DriveInfo } from '../common/control-api.js';
import { powershellPath, systemDirectory } from '../common/system-paths.js';
import type { ProcessResult } from './system.js';

/**
 * The PC's logical drives for the folder editor. One PowerShell (`Win32_LogicalDisk`) answers everything at once, with
 * a 5 s timeout; when it fails, times out or prints nothing usable, every letter from A: to Z: is probed with `statfs`
 * (sizes only: the kind and the label need Windows' own answer). The output encoding is set to UTF-8 first, because a
 * piped PowerShell otherwise prints a volume label such as "Mídia" in the OEM code page.
 */
export const DRIVES_POWERSHELL_SCRIPT =
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ' +
  'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,Size,FreeSpace | ConvertTo-Json';

const POWERSHELL_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_500;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The fields of `fs.statfs` that the fallback uses. */
export interface StatfsResult {
  bsize: number;
  blocks: number;
  /** Blocks available to a non-privileged user (the free space Explorer shows). */
  bavail: number;
}

export interface DrivesDeps {
  /**
   * Runs a short-lived hidden process (`runProcess` in production). Resolves for every outcome; rejects when it cannot
   * start. `cwd` is a folder normal users cannot write to, so nothing planted there can be picked up as the program.
   */
  run(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<ProcessResult>;
  statfs(path: string): Promise<StatfsResult>;
  /** How long one letter may take in the fallback (an unplugged network drive can hang). */
  probeTimeoutMs?: number;
}

/** `Win32_LogicalDisk.DriveType`: 2 removable, 3 local disk, 4 network, 5 optical; the rest is unknown. */
export function driveKind(driveType: unknown): DriveInfo['kind'] {
  const value = typeof driveType === 'string' ? Number(driveType) : driveType;
  switch (value) {
    case 2:
      return 'removable';
    case 3:
      return 'fixed';
    case 4:
      return 'network';
    case 5:
      return 'optical';
    default:
      return 'unknown';
  }
}

function byteCount(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null;
}

function labelOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label === '' ? null : label;
}

function toDrive(item: unknown): DriveInfo | null {
  if (typeof item !== 'object' || item === null) return null;
  const record = item as Record<string, unknown>;
  const id = typeof record.DeviceID === 'string' ? record.DeviceID.trim() : '';
  if (!/^[A-Za-z]:$/.test(id)) return null;
  // DriveType 1: "no root directory", nothing to open.
  if (record.DriveType === 1 || record.DriveType === '1') return null;

  const total = byteCount(record.Size);
  const free = byteCount(record.FreeSpace);
  return {
    root: `${id.toUpperCase()}\\`,
    label: labelOf(record.VolumeName),
    kind: driveKind(record.DriveType),
    totalBytes: total,
    freeBytes: total !== null && free !== null ? Math.min(free, total) : free,
  };
}

/**
 * Parses what `ConvertTo-Json` printed: an array for several disks, a bare object for one, and nulls for a drive
 * without media. Entries without a drive letter are skipped; the result is sorted by letter without duplicates. Empty
 * output is an empty list; text that is not JSON is `null` (a failure, unlike "no drives").
 */
export function parseDrivesJson(text: string): DriveInfo[] | null {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set<string>();
  const drives: DriveInfo[] = [];
  for (const item of items) {
    const drive = toDrive(item);
    if (drive === null || seen.has(drive.root)) continue;
    seen.add(drive.root);
    drives.push(drive);
  }
  return drives.sort((a, b) => a.root.localeCompare(b.root));
}

async function queryPowerShell(deps: DrivesDeps): Promise<DriveInfo[] | null> {
  let result: ProcessResult;
  try {
    result = await deps.run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', DRIVES_POWERSHELL_SCRIPT], {
      cwd: systemDirectory(),
      timeoutMs: POWERSHELL_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (result.timedOut || result.exitCode !== 0) return null;
  const drives = parseDrivesJson(result.stdout);
  return drives !== null && drives.length > 0 ? drives : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('tempo esgotado')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function probeLetters(deps: DrivesDeps): Promise<DriveInfo[]> {
  const timeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probes = [...LETTERS].map(async (letter): Promise<DriveInfo | null> => {
    const root = `${letter}:\\`;
    try {
      const stats = await withTimeout(deps.statfs(root), timeoutMs);
      const total = stats.bsize * stats.blocks;
      const known = Number.isFinite(total) && total > 0;
      return {
        root,
        label: null,
        kind: 'unknown',
        totalBytes: known ? total : null,
        freeBytes: known ? stats.bsize * stats.bavail : null,
      };
    } catch {
      return null;
    }
  });
  return (await Promise.all(probes)).filter((drive): drive is DriveInfo => drive !== null);
}

/** The drives of this PC: PowerShell's answer, else the letter probe. Never throws; an empty list means none were found. */
export async function listDrives(deps: DrivesDeps): Promise<DriveInfo[]> {
  return (await queryPowerShell(deps)) ?? (await probeLetters(deps));
}

export interface DriveListerOptions {
  /** How long an answer is reused. Default 5 s: a drive plugged in a moment ago shows up on the next look after that. */
  cacheMs?: number;
  now?: () => number;
}

const DEFAULT_CACHE_MS = 5_000;

/**
 * `listDrives` with one lookup shared by calls that overlap (the section asks while an earlier ask is still running),
 * and the answer kept for a few seconds so that a window that gets the focus again does not start another PowerShell.
 */
export function createDriveLister(deps: DrivesDeps, options: DriveListerOptions = {}): () => Promise<DriveInfo[]> {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const now = options.now ?? Date.now;
  let running: Promise<DriveInfo[]> | null = null;
  let cached: { at: number; drives: DriveInfo[] } | null = null;
  return async () => {
    if (cached !== null && now() - cached.at < cacheMs) return cached.drives.map((drive) => ({ ...drive }));
    running ??= listDrives(deps)
      .then((drives) => {
        cached = { at: now(), drives };
        return drives;
      })
      .finally(() => {
        running = null;
      });
    return (await running).map((drive) => ({ ...drive }));
  };
}
