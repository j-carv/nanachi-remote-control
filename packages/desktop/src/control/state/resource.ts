import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ControlResult } from '../../common/control-api.js';
import { createResourceCore, type ResourceState } from './resource-core.js';

export { plain, settle, type ResourceState } from './resource-core.js';

export interface Resource<T> {
  state: ResourceState<T>;
  /** Loads again. `silent` keeps the current data on screen (no skeleton) and ignores a failure when there is data. */
  reload: (silent?: boolean) => Promise<void>;
  /** Replaces the data with a value the caller already has (the answer of a mutation). */
  setData: (data: T) => void;
}

export interface ResourceOptions {
  /** False postpones the first load (a section nobody opened yet). */
  enabled?: boolean;
  /** Polls silently while the page is visible. */
  intervalMs?: number;
  /** An answer equal to the current data keeps the same state object (no re-render for a poll that found nothing new). */
  equals?: (previous: unknown, next: unknown) => boolean;
}

/** Loading, ready and error state of one call, with a stale-answer guard (only the latest request lands). */
export function useResource<T>(load: () => Promise<ControlResult<T>>, options: ResourceOptions = {}): Resource<T> {
  const { enabled = true, intervalMs, equals } = options;
  const latestLoad = useRef(load);
  const latestEquals = useRef(equals);
  useEffect(() => {
    latestLoad.current = load;
    latestEquals.current = equals;
  });

  const core = useMemo(
    () => createResourceCore<T>({ load: () => latestLoad.current(), equals: (previous, next) => latestEquals.current?.(previous, next) === true }),
    [],
  );
  useEffect(() => {
    core.setActive(true);
    return () => core.setActive(false);
  }, [core]);

  const state = useSyncExternalStore(core.subscribe, core.getState);
  const { reload, setData } = core;

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled || intervalMs === undefined) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void reload(true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, reload]);

  return useMemo(() => ({ state, reload, setData }), [state, reload, setData]);
}
