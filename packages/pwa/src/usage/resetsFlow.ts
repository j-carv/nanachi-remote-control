import type { ResetEntry } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { redeemFailureOf, redeemResultOf, type RedeemResult } from './resetsModel.js';

/** The "Resets salvos" list. `idle` until the usage has loaded, and for agents without resets. */
export type ResetsListState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; entries: ResetEntry[]; message: string | null }
  | { status: 'error'; error: unknown };

/** The redeem of one row. `done` keeps the reply until the next redeem or the next open of the panel. */
export type RedeemState =
  | { status: 'idle' }
  | { status: 'running'; target: string }
  | { status: 'done'; result: RedeemResult };

/**
 * Starts one list request and reports it through `onState`: `loading` first, then `ready` or `error`. The returned
 * function cancels it: a reply that arrives later is dropped, so a closed or refreshed panel never shows an old list.
 */
export function startResetsRequest(
  client: Pick<ApiClient, 'getUsageResets'>,
  sessionId: string,
  onState: (state: ResetsListState) => void,
): () => void {
  let current = true;
  onState({ status: 'loading' });
  client.getUsageResets(sessionId).then(
    (resets) => {
      if (current) onState({ status: 'ready', entries: resets.entries, message: resets.message });
    },
    (error: unknown) => {
      if (current) onState({ status: 'error', error });
    },
  );
  return () => {
    current = false;
  };
}

/**
 * Spends one reset. Sends exactly one request: whatever comes back, including a timeout, is reported and never retried.
 * `onState` gets `running`, then `done` (a failed request is a `done` with the error tone). `onSettled` runs once after
 * `done`, for the refetch of usage and resets. The returned function only silences the callbacks: a redeem that was
 * already sent cannot be taken back.
 */
export function startRedeem(
  client: Pick<ApiClient, 'redeemUsageReset'>,
  sessionId: string,
  target: string,
  onState: (state: RedeemState) => void,
  onSettled: () => void,
): () => void {
  let current = true;
  const finish = (result: RedeemResult) => {
    if (!current) return;
    onState({ status: 'done', result });
    onSettled();
  };
  onState({ status: 'running', target });
  client.redeemUsageReset(sessionId, target).then(
    (response) => finish(redeemResultOf(response)),
    (error: unknown) => finish(redeemFailureOf(error)),
  );
  return () => {
    current = false;
  };
}
