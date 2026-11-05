import type { SessionsViewport } from '../common/control-api.js';

/**
 * The rules of the sessions view that need no Electron: what the page may report, how the reported rectangle becomes view
 * bounds, and when the view is shown. `sessions-view.ts` applies them; the tests pin them.
 */

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContentSize {
  width: number;
  height: number;
}

export interface SessionsViewDecision {
  visible: boolean;
  /** Where the view goes; null when there is nothing sensible to draw (no report yet, or an empty area). */
  bounds: ViewBounds | null;
}

/** No window is this big; a larger number is a bug or a hostile page, and is refused. */
const MAX_DIP = 100_000;

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_DIP;
}

/** The report as the page sent it, or null when any field is missing or not usable. Unknown fields are dropped. */
export function parseViewport(value: unknown): SessionsViewport | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, width, height, active, covered } = value as Record<string, unknown>;
  if (!isCoordinate(x) || !isCoordinate(y) || !isCoordinate(width) || !isCoordinate(height)) return null;
  if (typeof active !== 'boolean' || typeof covered !== 'boolean') return null;
  return { x, y, width, height, active, covered };
}

/**
 * Whole-pixel bounds for the reported rectangle, inside the window content. The edges are rounded, not the sizes, so the
 * view and what sits next to it never leave a gap or overlap by a pixel. Null when nothing is left to draw.
 */
export function viewBounds(rect: { x: number; y: number; width: number; height: number }, content: ContentSize): ViewBounds | null {
  const left = Math.max(0, Math.round(rect.x));
  const top = Math.max(0, Math.round(rect.y));
  const right = Math.min(Math.round(content.width), Math.round(rect.x + rect.width));
  const bottom = Math.min(Math.round(content.height), Math.round(rect.y + rect.height));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The view is shown only while the sessions section is on screen, nothing of the control center needs that area (a
 * dialog, a toast) and the daemon is ready; every other time it is hidden. The bounds are kept either way, so it comes back
 * where it was.
 */
export function decideSessionsView(input: { viewport: SessionsViewport | null; daemonReady: boolean; contentSize: ContentSize }): SessionsViewDecision {
  const { viewport } = input;
  if (viewport === null) return { visible: false, bounds: null };
  const bounds = viewBounds(viewport, input.contentSize);
  return { visible: bounds !== null && viewport.active && !viewport.covered && input.daemonReady, bounds };
}
