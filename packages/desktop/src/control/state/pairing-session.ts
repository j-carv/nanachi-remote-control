import { useMemo, useSyncExternalStore } from 'react';
import type { ControlApi, ControlResult } from '../../common/control-api.js';
import type { PairingCode } from '../../common/types.js';
import { CLOSED, needsCode, reducePairing, type PairingAction, type PairingSession } from '../lib/pairing-session.js';
import { settle } from './resource.js';

export type PairingRequest = () => Promise<ControlResult<PairingCode>>;

/** The store the shell creates once. Its methods do not change, so they can sit in effects and callbacks without re-subscribing. */
export interface PairingSessionStore {
  getState(): PairingSession;
  subscribe(listener: () => void): () => void;
  /** Opens the panel. Asks for a code only when none is live, so a remount never asks again. */
  open(): void;
  /** Closes the panel and forgets its code. */
  close(): void;
  /** Asks for another code, unless one is already on its way. */
  regenerate(): void;
}

/** What the panel reads and does, as the shell hands it to the devices section. */
export interface PairingController {
  readonly session: PairingSession;
  open(): void;
  close(): void;
  regenerate(): void;
}

/**
 * The pairing panel's state, outside React so that its rules can be tested with a fake request and clock. Main is asked
 * through `request`; `clock` is the time an answer is stamped with.
 */
export function createPairingSessionStore(request: PairingRequest, clock: () => number = Date.now): PairingSessionStore {
  let state: PairingSession = CLOSED;
  const listeners = new Set<() => void>();

  function dispatch(action: PairingAction): void {
    const next = reducePairing(state, action);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  async function ask(): Promise<void> {
    dispatch({ type: 'request' });
    const result = await settle(request);
    dispatch(result.ok ? { type: 'issued', code: result.value, now: clock() } : { type: 'failed', error: result });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open() {
      dispatch({ type: 'open' });
      if (needsCode(state, clock())) void ask();
    },
    close() {
      dispatch({ type: 'close' });
    },
    regenerate() {
      if (!state.pending) void ask();
    },
  };
}

/** The one store of the control center, for the life of the window. */
export function usePairingSessionStore(api: ControlApi): PairingSessionStore {
  return useMemo(() => createPairingSessionStore(() => api.devices.pairingCode()), [api]);
}

/** The panel's state from its store, as a value that changes with the state. */
export function usePairingSession(store: PairingSessionStore): PairingController {
  const session = useSyncExternalStore(store.subscribe, store.getState);
  return useMemo(() => ({ session, open: store.open, close: store.close, regenerate: store.regenerate }), [session, store]);
}
