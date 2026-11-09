import { useSyncExternalStore } from 'react';
import type { LogTab } from '../sections/LogsSection.js';
import { FOLLOWING, type LogPosition } from '../lib/log-view.js';

/**
 * Where each log tab's viewer was left. The shell keeps it, so it survives switching sections: the section remounts on every
 * switch, and the viewer restores from here.
 */
export interface LogViewStore {
  getState(tab: LogTab): LogPosition;
  subscribe(listener: () => void): () => void;
  /** Records whether the viewer follows the end. Listeners hear about it only when it changes. */
  setFollowing(tab: LogTab, following: boolean): void;
  /** Records the scroll offset. Silent: scrolling must not re-render the section. */
  setScrollTop(tab: LogTab, scrollTop: number): void;
}

export function createLogViewStore(): LogViewStore {
  const positions: Record<LogTab, LogPosition> = { daemon: FOLLOWING, tailscale: FOLLOWING };
  const listeners = new Set<() => void>();

  return {
    getState: (tab) => positions[tab],
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setFollowing(tab, following) {
      const current = positions[tab];
      if (current.following === following) return;
      positions[tab] = { ...current, following };
      for (const listener of [...listeners]) listener();
    },
    setScrollTop(tab, scrollTop) {
      const current = positions[tab];
      if (current.scrollTop === scrollTop) return;
      positions[tab] = { ...current, scrollTop };
    },
  };
}

/** Whether a tab's viewer follows the end of its log, as a value that changes with it. */
export function useLogFollowing(store: LogViewStore, tab: LogTab): boolean {
  return useSyncExternalStore(store.subscribe, () => store.getState(tab).following);
}
