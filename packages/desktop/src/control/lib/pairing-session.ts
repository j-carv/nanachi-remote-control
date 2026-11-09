import type { ControlError } from '../../common/control-api.js';
import type { PairingCode } from '../../common/types.js';

/** A code the panel shows. It stays on screen after it expires, until the panel closes. */
export interface IssuedCode {
  readonly code: string;
  /** Epoch ms, from main. */
  readonly expiresAt: number;
  /** Epoch ms, when the code arrived here. */
  readonly startedAt: number;
  readonly externalOrigin?: string;
}

/** The pairing panel's state. The shell keeps it, so it survives switching sections. */
export interface PairingSession {
  /** The panel is on screen. */
  readonly open: boolean;
  /** A code is on its way from main. */
  readonly pending: boolean;
  readonly issued: IssuedCode | null;
  /** The last request failed: the panel says so and offers to try again. */
  readonly failed: ControlError | null;
}

export const CLOSED: PairingSession = { open: false, pending: false, issued: null, failed: null };

export type PairingAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'request' }
  | { type: 'issued'; code: PairingCode; now: number }
  | { type: 'failed'; error: ControlError };

/**
 * Closing the panel forgets its code, but a request still on its way is remembered, so that opening the panel again does not
 * ask main a second time. An answer that arrives while the panel is closed is dropped: nothing shows it.
 */
export function reducePairing(state: PairingSession, action: PairingAction): PairingSession {
  switch (action.type) {
    case 'open':
      return state.open ? state : { ...state, open: true };
    case 'close':
      return state.open || state.issued !== null || state.failed !== null ? { ...CLOSED, pending: state.pending } : state;
    case 'request':
      return { ...state, pending: true, failed: null };
    case 'issued':
      if (!state.open) return { ...state, pending: false };
      return {
        ...state,
        pending: false,
        failed: null,
        issued: { ...action.code, startedAt: action.now },
      };
    case 'failed':
      if (!state.open) return { ...state, pending: false };
      return { ...state, pending: false, failed: action.error };
  }
}

/**
 * Whether opening the panel should ask main for a code: none is on its way, and the one on screen (if any) has run out. An
 * expired code is replaced only by an explicit open or by the panel's button, never by a remount or by time passing.
 */
export function needsCode(state: PairingSession, now: number): boolean {
  if (state.pending) return false;
  return state.issued === null || state.issued.expiresAt <= now;
}
