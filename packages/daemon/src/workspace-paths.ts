import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { ApiError } from './api-error.js';
import { isInside } from './roots.js';

/** Longest path (in characters) accepted from a client. The PWA never sends anything close to it. */
export const PATH_MAX_CHARS = 1024;
/** Longest single path component (the NTFS limit). */
const SEGMENT_MAX_CHARS = 255;
/** Characters Windows does not allow in file names. `:` has its own rule (alternate data streams and drive names). */
const FORBIDDEN_CHARS = /[<>"|?*]/;
/** NUL byte and C0 / DEL control characters. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** Absolute start: slash, backslash (UNC) or a drive letter. */
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:|[\\/])/;
/** DOS device names, with or without an extension. COM and LPT with superscript digits (¹²³) count too. */
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/;
/** 8.3 short name Windows generates for `.git` (`GIT~1`). Without this, `GIT~1/config` would bypass the `.git` rule. */
const SHORT_GIT_NAME = /^GIT~\d+$/i;

/** A validated path: `rel` uses `/` (empty = workspace root); `abs` is the path to use on disk. */
export interface ResolvedPath {
  rel: string;
  abs: string;
}

function invalidPath(reason: string): ApiError {
  return new ApiError(400, 'invalid_path', `invalid path: ${reason}`);
}

/** One path component: no character Windows forbids, not `.git`, not a reserved device name. */
function assertSegmentName(name: string): void {
  if (Array.from(name).length > SEGMENT_MAX_CHARS) throw invalidPath('name too long');
  if (FORBIDDEN_CHARS.test(name) || name.includes(':')) throw invalidPath('forbidden character');
  if (name.endsWith('.') || name.endsWith(' ')) throw invalidPath('name ends with a dot or space');
  if (name.toLowerCase() === '.git' || SHORT_GIT_NAME.test(name)) throw invalidPath('.git is not reachable');
  const stem = (name.split('.', 1)[0] ?? '').trimEnd().toUpperCase();
  if (DEVICE_NAME.test(stem)) throw invalidPath('reserved Windows name');
}

/**
 * Turns the client's path into normalized components without touching the disk.
 * `..` above the root → 403 `outside_workspace`; absolute paths, NUL, forbidden names → 400 `invalid_path`.
 */
export function parseRelativePath(input: string): string[] {
  if (input.length > PATH_MAX_CHARS) throw invalidPath('path too long');
  if (CONTROL_CHARS.test(input)) throw invalidPath('control character');
  if (ABSOLUTE_PATH.test(input)) throw invalidPath('absolute path');

  const segments: string[] = [];
  for (const part of input.split(/[\\/]/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) {
        throw new ApiError(403, 'outside_workspace', 'path leaves the workspace folder');
      }
      segments.pop();
      continue;
    }
    assertSegmentName(part);
    segments.push(part);
  }
  return segments;
}

/** Real path of `lexical`, or 404 when it does not exist (a dangling link included). */
function realpathOf(lexical: string): string {
  try {
    return realpathSync.native(lexical);
  } catch {
    throw new ApiError(404, 'not_found', 'path not found');
  }
}

/**
 * The real path must stay inside the real root, and each of its components must pass the same name rules.
 * This refuses a link or junction that points outside (403) or into `.git` (400).
 */
function assertRealInside(realRoot: string, real: string): string {
  if (!isInside(real, realRoot)) {
    throw new ApiError(403, 'outside_workspace', 'link or junction points outside the workspace');
  }
  const below = real.slice(realRoot.length);
  for (const name of below.split(sep)) {
    if (name !== '') assertSegmentName(name);
  }
  return real;
}

/**
 * Real root of the workspace (links resolved). A missing folder → 404, so nothing is resolved against a path
 * that does not exist.
 */
export function realRootOf(workspacePath: string): string {
  return realpathOf(workspacePath);
}

/**
 * An entry that already exists and is read or listed: the last component is followed, so a link resolves to its
 * target, which must be inside the workspace. The root (empty `rel`) is accepted.
 */
export function resolveExisting(realRoot: string, input: string): ResolvedPath {
  const segments = parseRelativePath(input);
  if (segments.length === 0) return { rel: '', abs: realRoot };
  const real = assertRealInside(realRoot, realpathOf(join(realRoot, ...segments)));
  return { rel: segments.join('/'), abs: real };
}

/**
 * An entry that may not exist yet (create, write, mkdir, rename, delete). The parent folder is resolved and checked
 * like in `resolveExisting`; the last component is NOT followed. That way deleting a link removes the link, never
 * its target. An empty `rel` (the root) comes back resolved, and the caller decides whether the root is allowed.
 */
export function resolveEntry(realRoot: string, input: string): ResolvedPath {
  const segments = parseRelativePath(input);
  if (segments.length === 0) return { rel: '', abs: realRoot };
  const parent = segments.slice(0, -1);
  const last = segments[segments.length - 1] ?? '';
  const realParent =
    parent.length === 0 ? realRoot : assertRealInside(realRoot, realpathOf(join(realRoot, ...parent)));
  return { rel: segments.join('/'), abs: join(realParent, last) };
}
