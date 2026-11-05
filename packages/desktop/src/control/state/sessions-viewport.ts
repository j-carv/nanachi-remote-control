import { useEffect, type RefObject } from 'react';
import type { ControlApi, SessionsViewport } from '../../common/control-api.js';

/** What a measured element says about itself, in the page's own coordinates (DIP: the page is never zoomed). */
export interface MeasuredRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function viewportOf(rect: MeasuredRect, flags: { active: boolean; covered: boolean }): SessionsViewport {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height, active: flags.active, covered: flags.covered };
}

/** A report that says what the last one said needs no message. */
export function sameViewport(a: SessionsViewport | null, b: SessionsViewport): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.active === b.active && a.covered === b.covered;
}

/**
 * Keeps main told where the sessions view goes: the content area (`element`, the `<main>` below the title bar and right of
 * the sidebar) and whether it is the section on screen. It reports once at once and again whenever the area changes size
 * (a resize observer: the window resizing, the sidebar collapsing, a dialog or toast covering it). A failed call is dropped:
 * the next change sends the whole state again.
 */
export function useSessionsViewport(api: ControlApi, element: RefObject<HTMLElement | null>, flags: { active: boolean; covered: boolean }): void {
  const { active, covered } = flags;
  useEffect(() => {
    const target = element.current;
    if (target === null) return undefined;
    let last: SessionsViewport | null = null;
    const report = (): void => {
      const next = viewportOf(target.getBoundingClientRect(), { active, covered });
      if (sameViewport(last, next)) return;
      last = next;
      api.sessions.setViewport(next).catch(() => {
        // Main is gone or refused; the next change reports again.
        last = null;
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(target);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [api, element, active, covered]);
}
