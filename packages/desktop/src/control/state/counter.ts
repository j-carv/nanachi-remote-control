import { useSyncExternalStore } from 'react';

/** A count of things that are on screen, with the hook that follows whether there is any. */
export interface Counter {
  /** Counts one more. Returns the function that takes it off; calling it twice counts once. */
  acquire(): () => void;
  /** True while anything is counted. */
  active(): boolean;
  /** `active()` as a hook: the component re-renders when it changes. */
  useActive(): boolean;
}

export function createCounter(): Counter {
  let count = 0;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }
  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }
  function active(): boolean {
    return count > 0;
  }

  return {
    acquire() {
      count += 1;
      emit();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
        emit();
      };
    },
    active,
    useActive: () => useSyncExternalStore(subscribe, active, () => false),
  };
}
