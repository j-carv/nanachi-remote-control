import { pathToFileURL } from 'node:url';
import type { IpcCallerLike } from '../install/sender.js';
import { backgroundColor } from './panel-policy.js';
import type { ControlWindowBounds } from './settings.js';
import { RELEASES_REPO } from './updates.js';

/**
 * The rules of the control center window that need no Electron: who may call in, which external addresses may be opened,
 * which permissions the page gets and where a restored window may sit. `control-window.ts` applies them; the tests pin them.
 */

export const CONTROL_WINDOW_SIZE = { width: 1180, height: 760, minWidth: 940, minHeight: 620 } as const;

/** The control center keeps its own cookies and storage, apart from the panel (which shows the daemon's PWA). */
export const CONTROL_PARTITION = 'persist:nanachi-control';

/** Window background before the page paints. Same values as the panel: `--ui-background` light and dark. */
export function controlBackgroundColor(dark: boolean): string {
  return backgroundColor(dark);
}

/** The security preferences of the control center window. A test pins them so nobody loosens one by accident. */
export function controlWebPreferences(preload: string): {
  preload: string;
  partition: string;
  contextIsolation: true;
  sandbox: true;
  nodeIntegration: false;
  webSecurity: true;
  allowRunningInsecureContent: false;
  webviewTag: false;
  spellcheck: false;
  navigateOnDragDrop: false;
} {
  return {
    preload,
    partition: CONTROL_PARTITION,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
  };
}

/** Decoded path of a `file:` URL, or null for anything else (another scheme, a `file://server/share` host, a malformed escape). */
function localPathOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  if (parsed.hostname !== '' && parsed.hostname !== 'localhost') return null;
  try {
    return decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
}

/** Windows paths ignore case; elsewhere they do not. */
function fold(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** True when `url` is the control center's own `index.html` (a hash or query on it is fine). */
export function isLocalControlUrl(url: string | undefined, indexPath: string): boolean {
  if (url === undefined) return false;
  const actual = localPathOf(url);
  const expected = localPathOf(pathToFileURL(indexPath).href);
  return actual !== null && expected !== null && fold(actual) === fold(expected);
}

/**
 * True when the message came from the main frame of the control window (its web contents id, read by the caller when
 * the message arrives; null means there is no window and nobody is trusted), still showing its own local page. A subframe
 * is refused even when it is local. The panel, the installer and the pairing window are different web contents.
 */
export function isControlCaller(event: IpcCallerLike, contentsId: number | null, indexPath: string): boolean {
  if (contentsId === null || event.sender.id !== contentsId) return false;
  const frame = event.senderFrame;
  if (frame === undefined || frame === null) return false;
  if (frame.parent !== undefined && frame.parent !== null) return false;
  return isLocalControlUrl(frame.url, indexPath);
}

const MAX_URL_LENGTH = 2048;

function parseHttps(url: unknown): URL | null {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
  return parsed;
}

/** The Tailscale login page is the only address "Entrar" may open. Returns the normalized address, or null. */
export function isAllowedLoginUrl(url: string): string | null {
  const parsed = parseHttps(url);
  return parsed !== null && parsed.hostname === 'login.tailscale.com' ? parsed.href : null;
}

const RELEASES_PATH = `/${RELEASES_REPO}/releases`.toLowerCase();

/** The releases pages of this repository are the only addresses an update may open. Returns the normalized address, or null. */
export function isAllowedReleaseUrl(url: string): string | null {
  const parsed = parseHttps(url);
  if (parsed === null || parsed.hostname !== 'github.com') return null;
  const path = parsed.pathname.toLowerCase();
  return path === RELEASES_PATH || path.startsWith(`${RELEASES_PATH}/`) ? parsed.href : null;
}

/** The only permission the control center page gets: writing to the clipboard ("Copiar"), and only from its own page. */
export function isControlPermissionAllowed(permission: string, requestingUrl: string, indexPath: string): boolean {
  return permission === 'clipboard-sanitized-write' && isLocalControlUrl(requestingUrl, indexPath);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InitialBounds {
  /** Absent: let the system center the window. */
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** Height of the title bar the user drags, and how much of it (and how wide) must be on a screen to be reachable. */
const TITLE_BAR_HEIGHT = 40;
const MIN_VISIBLE_WIDTH = 160;
const MIN_VISIBLE_HEIGHT = 24;

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where and how big to open the window. The saved size is kept (never under the minimum, never bigger than the biggest
 * work area); the saved position is kept only when the title bar can still be grabbed on a connected screen (a
 * monitor that was unplugged would otherwise leave the window out of reach). Without a position the system centers it.
 */
export function initialBounds(saved: ControlWindowBounds | undefined, workAreas: readonly Rect[]): InitialBounds {
  const { width: defaultWidth, height: defaultHeight, minWidth, minHeight } = CONTROL_WINDOW_SIZE;
  // The biggest work area bounds the size; with no display information there is no bound.
  const limitWidth = workAreas.length > 0 ? Math.max(...workAreas.map((area) => area.width)) : Number.POSITIVE_INFINITY;
  const limitHeight = workAreas.length > 0 ? Math.max(...workAreas.map((area) => area.height)) : Number.POSITIVE_INFINITY;

  const width = clamp(saved?.width ?? defaultWidth, minWidth, limitWidth);
  const height = clamp(saved?.height ?? defaultHeight, minHeight, limitHeight);
  const maximized = saved?.maximized === true;

  if (saved?.x !== undefined && saved.y !== undefined) {
    const titleBar: Rect = { x: saved.x, y: saved.y, width, height: TITLE_BAR_HEIGHT };
    const reachable = workAreas.some((area) => {
      const shared = overlap(titleBar, area);
      return shared.width >= MIN_VISIBLE_WIDTH && shared.height >= MIN_VISIBLE_HEIGHT;
    });
    if (reachable) return { x: saved.x, y: saved.y, width, height, maximized };
  }
  return { width, height, maximized };
}
