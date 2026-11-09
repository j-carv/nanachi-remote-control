import { UNINSTALL_GUARD_MS, uninstallGuardRemaining } from '../../common/uninstall-guard.js';

export interface UninstallGuardOptions {
  /** A monotonic clock in milliseconds. */
  clock(): number;
  /** Runs `callback` after `ms`; returns the way to cancel it. */
  schedule(callback: () => void, ms: number): () => void;
}

/**
 * The guard on the uninstall button. The shell keeps it, so it survives switching sections: the section remounts on every
 * switch, and a remount must neither re-enable the button nor restart its window.
 */
export interface UninstallGuardStore {
  /** When the press that holds the guard was made, or `null` while none does. */
  getState(): number | null;
  subscribe(listener: () => void): () => void;
  /** Holds the guard and returns true. While it already holds, the press is ignored and the result is false. */
  press(): boolean;
}

/** The store, outside React, so that its rules can be tested with a fake clock and timer. */
export function createUninstallGuardStore({ clock, schedule }: UninstallGuardOptions): UninstallGuardStore {
  let startedAt: number | null = null;
  let cancel: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function arm(ms: number): void {
    cancel = schedule(release, ms);
  }

  /** The timer ends the guard, but only when the clock agrees the window is over: a wake-up that comes early waits for the rest. */
  function release(): void {
    cancel = null;
    const left = uninstallGuardRemaining(startedAt, clock());
    if (left > 0) {
      arm(left);
      return;
    }
    startedAt = null;
    notify();
  }

  return {
    getState: () => startedAt,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    press() {
      const now = clock();
      if (uninstallGuardRemaining(startedAt, now) > 0) return false;
      cancel?.();
      startedAt = now;
      arm(UNINSTALL_GUARD_MS);
      notify();
      return true;
    },
  };
}
