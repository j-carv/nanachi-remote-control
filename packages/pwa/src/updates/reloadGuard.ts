import { useEffect } from 'react';

// Counts the reasons not to reload the app right now (for example, unsent text in the
// composer). The update prompt reads it; the app itself never reloads from here.
let holds = 0;
const listeners = new Set<() => void>();

/** True while at least one screen holds the reload. */
export function isReloadHeld(): boolean {
  return holds > 0;
}

/** Calls `listener` whenever the hold count changes from zero or back to zero. Returns the unsubscribe function. */
export function subscribeReloadHeld(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function change(delta: number): void {
  const wasHeld = holds > 0;
  holds += delta;
  if (wasHeld !== holds > 0) {
    for (const listener of listeners) listener();
  }
}

/** Holds the reload while `active` is true, for example while the composer has unsent text. */
export function useReloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    change(1);
    return () => change(-1);
  }, [active]);
}
