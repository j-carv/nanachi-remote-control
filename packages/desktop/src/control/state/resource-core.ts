import type { ControlError, ControlResult } from '../../common/control-api.js';
import { toControlError } from '../lib/errors.js';

export type ResourceState<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ControlError };

/** A rejected IPC call is a failure like any other: it becomes a `ControlError`, never an unhandled rejection. */
export async function settle<T>(load: () => Promise<ControlResult<T>>): Promise<ControlResult<T>> {
  try {
    return await load();
  } catch (error) {
    return toControlError(error);
  }
}

/** Wraps a call that answers a plain value (tailscale, logs) in the `ControlResult` shape. */
export async function plain<T>(load: () => Promise<T>): Promise<ControlResult<T>> {
  try {
    return { ok: true, value: await load() };
  } catch (error) {
    return toControlError(error);
  }
}

export interface ResourceCoreOptions<T> {
  /** Called on every reload, so it may read the latest props of the owner. */
  load: () => Promise<ControlResult<T>>;
  /** An answer equal to the current data keeps the same state object (no re-render for a poll that found nothing new). */
  equals?: (previous: unknown, next: unknown) => boolean;
}

/**
 * The state machine behind `useResource`, without React so that its rules can be tested: loading, ready and error state
 * of one call, with a stale-answer guard (only the latest request lands; a mutation's `setData` also counts as newer than
 * every call that was already on its way) and a switch for when the owner is gone.
 */
export interface ResourceCore<T> {
  getState(): ResourceState<T>;
  subscribe(listener: () => void): () => void;
  /** Loads again. `silent` keeps the current data on screen (no skeleton) and ignores a failure when there is data. */
  reload(silent?: boolean): Promise<void>;
  /** Replaces the data with a value the caller already has (the answer of a mutation). */
  setData(data: T): void;
  /** False drops every answer that arrives from now on (the owner unmounted); true takes them again. */
  setActive(active: boolean): void;
}

export function createResourceCore<T>(options: ResourceCoreOptions<T>): ResourceCore<T> {
  let state: ResourceState<T> = { status: 'loading' };
  let request = 0;
  let active = true;
  const listeners = new Set<() => void>();

  function change(next: ResourceState<T>): void {
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async reload(silent = false) {
      request += 1;
      const id = request;
      if (!silent && state.status !== 'loading') change({ status: 'loading' });
      const result = await settle(() => options.load());
      if (!active || id !== request) return;
      if (result.ok) {
        if (state.status === 'ready' && options.equals?.(state.data, result.value) === true) return;
        change({ status: 'ready', data: result.value });
      } else if (!(silent && state.status === 'ready')) {
        change({ status: 'error', error: result });
      }
    },
    setData(data) {
      request += 1;
      change({ status: 'ready', data });
    },
    setActive(value) {
      active = value;
    },
  };
}
