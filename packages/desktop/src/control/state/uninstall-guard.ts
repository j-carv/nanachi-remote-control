import { useMemo, useState, useSyncExternalStore } from 'react';
import { createUninstallGuardStore, type UninstallGuardStore } from '../lib/uninstall-guard.js';

/** What Settings reads and does: whether the uninstall button is held off, and a press. */
export interface UninstallGuardController {
  readonly active: boolean;
  /** A press. False, and nothing starts, while the guard already holds. */
  press(): boolean;
}

/** The one guard of the control center, for the life of the window. Monotonic time, so a change of the wall clock cannot move it. */
export function useUninstallGuardStore(): UninstallGuardStore {
  const [store] = useState(() =>
    createUninstallGuardStore({
      clock: () => performance.now(),
      schedule: (callback, ms) => {
        const handle = window.setTimeout(callback, ms);
        return () => window.clearTimeout(handle);
      },
    }),
  );
  return store;
}

/** The guard from its store, as a value that changes with the guard. */
export function useUninstallGuard(store: UninstallGuardStore): UninstallGuardController {
  const startedAt = useSyncExternalStore(store.subscribe, store.getState);
  return useMemo(() => ({ active: startedAt !== null, press: store.press }), [startedAt, store]);
}
