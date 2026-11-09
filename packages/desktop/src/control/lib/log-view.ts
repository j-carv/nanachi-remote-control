import { isNearBottom } from './logs.js';

/** How a log viewer was left: whether it followed the end, and where it was scrolled. */
export interface LogPosition {
  readonly following: boolean;
  /** Pixels from the top of the log. Only meaningful while the viewer is not following. */
  readonly scrollTop: number;
}

/** A viewer that has not been scrolled yet: it follows the end. */
export const FOLLOWING: LogPosition = { following: true, scrollTop: 0 };

/** The size of a scroll box, measured after the lines are rendered. The content length is its `scrollHeight`. */
export interface ViewportSize {
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/** How far the box can scroll: the offset of its end (zero when the content fits). */
export function maxScrollTop(size: ViewportSize): number {
  return Math.max(0, size.scrollHeight - size.clientHeight);
}

/**
 * Where a viewer that is shown again starts. A viewer that was following stays pinned to the end, with the new lines. A paused
 * one goes back to the offset it was left at, clamped to the log as it is now: lines that arrived while away move the end, not
 * the lines in view, so the offset is kept. If the clamp leaves it within the follow threshold of the end, it follows, as a
 * scroll there would.
 */
export function restoreView(saved: LogPosition, size: ViewportSize): LogPosition {
  const bottom = maxScrollTop(size);
  if (saved.following) return { following: true, scrollTop: bottom };
  const scrollTop = Math.min(Math.max(saved.scrollTop, 0), bottom);
  return { following: isNearBottom({ scrollTop, clientHeight: size.clientHeight, scrollHeight: size.scrollHeight }), scrollTop };
}
