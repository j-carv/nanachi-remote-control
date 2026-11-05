import { useCallback, useEffect, useRef, useState } from 'react';
import { createApiClient, fetchHealth } from './api.js';
import { loadMachineOverview, type MachineOverview } from './machineOverview.js';
import type { Machine } from './machines.js';

/** A machine that does not answer in this time counts as offline (a dead Tailscale route can hang for minutes). */
const REQUEST_TIMEOUT_MS = 8_000;

const timedFetch = (url: string, init?: RequestInit): Promise<Response> =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

const DEPS = {
  fetchHealth: (baseUrl: string) => fetchHealth(baseUrl, timedFetch),
  client: (machine: Machine) => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }, timedFetch),
  now: () => performance.now(),
};

/**
 * Overview of every paired machine, keyed by machine id. Each machine loads in parallel and fills in when it
 * answers; an earlier refresh that finishes late is dropped. Loads on mount, on every change of the list, and
 * when the app comes back to the foreground. Data from the last load stays on screen while a refresh runs.
 */
export function useMachineOverviews(machines: readonly Machine[]): Readonly<Record<string, MachineOverview>> {
  const [overviews, setOverviews] = useState<Readonly<Record<string, MachineOverview>>>({});
  const generation = useRef(0);

  const refresh = useCallback(
    (list: readonly Machine[]) => {
      generation.current += 1;
      const current = generation.current;
      for (const machine of list) {
        loadMachineOverview(machine, DEPS).then((overview) => {
          if (generation.current !== current) return;
          setOverviews((previous) => ({ ...previous, [machine.id]: overview }));
        });
      }
    },
    [],
  );

  useEffect(() => {
    refresh(machines);
  }, [machines, refresh]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh(machines);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [machines, refresh]);

  return overviews;
}
