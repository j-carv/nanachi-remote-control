import type { ApiClient } from '../api.js';
import { parseUsage, type ParsedUsage } from './parseUsage.js';
import { startRedeem, startResetsRequest, type RedeemState, type ResetsListState } from './resetsFlow.js';

export type UsageState =
  | { status: 'loading' }
  | {
      status: 'ready';
      text: string;
      fetchedAt: number;
      /** The reply came from the daemon cache, not from a new probe. */
      cached: boolean;
      usage: ParsedUsage;
    }
  | { status: 'error'; error: unknown };

/**
 * Starts one usage request and reports it through `onState`: `loading` first, then `ready` or `error`.
 * The returned function cancels the request. A response that arrives after cancel is dropped, so a closed
 * or refreshed panel never shows a result from an older request.
 */
export function startUsageRequest(
  client: Pick<ApiClient, 'fetchSessionUsage'>,
  sessionId: string,
  onState: (state: UsageState) => void,
): () => void {
  let current = true;
  onState({ status: 'loading' });
  client.fetchSessionUsage(sessionId).then(
    (usage) => {
      if (!current) return;
      onState({
        status: 'ready',
        text: usage.text,
        fetchedAt: usage.fetchedAt,
        cached: usage.cached === true,
        usage: parseUsage(usage.agent, usage.text),
      });
    },
    (error: unknown) => {
      if (current) onState({ status: 'error', error });
    },
  );
  return () => {
    current = false;
  };
}

/** The part of the API client the usage panel uses. */
export type UsagePanelClient = Pick<ApiClient, 'fetchSessionUsage' | 'getUsageResets' | 'redeemUsageReset'>;

/** Everything the usage drawer shows. */
export interface UsagePanelState {
  usage: UsageState;
  /**
   * The quiet refresh after a redeem failed. `usage` still holds the last answer that worked, so the panel and the
   * reply of the redeem stay on screen and the footer says the numbers are old. Null otherwise.
   */
  refreshFailed: { error: unknown } | null;
  list: ResetsListState;
  /** The redeem of one row. A finished one (`done`) stays until the next redeem starts or the user dismisses it. */
  redeem: RedeemState;
}

const IDLE_LIST: ResetsListState = { status: 'idle' };
const IDLE_REDEEM: RedeemState = { status: 'idle' };

export const INITIAL_PANEL_STATE: UsagePanelState = {
  usage: { status: 'loading' },
  refreshFailed: null,
  list: IDLE_LIST,
  redeem: IDLE_REDEEM,
};

export interface UsagePanel {
  /** The drawer opened: a fresh usage request, then the resets list. A remembered redeem reply stays. */
  open(): void;
  /** The drawer closed: pending usage and list requests are dropped. A redeem already sent keeps running. */
  close(): void;
  /** "Atualizar uso". Ignored while closed or while a redeem runs. */
  refresh(): void;
  /** The confirmation's "Usar reset": the only way a redeem starts. Sends one request and never a second one. */
  redeem(target: string): void;
  /** The user dismissed the reply of a finished redeem. */
  dismissRedeem(): void;
  /** The drawer is gone for good: nothing is reported after this. */
  dispose(): void;
}

/**
 * The logic of the usage drawer, apart from React (docs/PLAN.md, "rate-limit resets"): usage first, then the resets
 * list for agents that have it. `onChange` gets the whole state after every change.
 *
 * A redeem keeps the loaded panel on screen: when it ends, usage and resets are read again without the skeleton. If
 * that read fails the last good usage stays (`refreshFailed`) and the list still leaves `loading`. A redeem that ends
 * while the drawer is closed keeps its reply for the next open, and none of this ever sends a redeem twice.
 */
export function createUsagePanel(
  client: UsagePanelClient,
  sessionId: string,
  withResets: boolean,
  onChange: (state: UsagePanelState) => void,
): UsagePanel {
  let state = INITIAL_PANEL_STATE;
  let isOpen = false;
  let disposed = false;
  let redeeming = false;
  let cancelUsage: (() => void) | null = null;
  let cancelList: (() => void) | null = null;
  let silenceRedeem: (() => void) | null = null;

  function update(patch: Partial<UsagePanelState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    onChange(state);
  }

  function loadList(): void {
    cancelList?.();
    cancelList = null;
    if (!withResets) return;
    cancelList = startResetsRequest(client, sessionId, (list) => update({ list }));
  }

  /** `quiet`: after a redeem. The panel stays as it is and the new usage replaces it when it arrives. */
  function loadUsage(quiet: boolean): void {
    cancelUsage?.();
    cancelList?.();
    cancelList = null;
    if (quiet) update({ refreshFailed: null });
    else update({ usage: { status: 'loading' }, refreshFailed: null, list: IDLE_LIST });
    cancelUsage = startUsageRequest(client, sessionId, (next) => {
      if (next.status === 'loading') return;
      if (next.status === 'ready') {
        update({ usage: next, refreshFailed: null });
        loadList();
        return;
      }
      if (quiet && state.usage.status === 'ready') {
        // The numbers on screen are the last good ones. The list is independent of them: read it anyway, so the
        // rows that were hidden for the redeem come back.
        update({ refreshFailed: { error: next.error } });
        loadList();
        return;
      }
      update({ usage: next });
    });
  }

  function stopRequests(): void {
    cancelUsage?.();
    cancelList?.();
    cancelUsage = null;
    cancelList = null;
  }

  onChange(state);

  return {
    open() {
      if (isOpen || disposed) return;
      isOpen = true;
      loadUsage(false);
    },

    close() {
      isOpen = false;
      stopRequests();
    },

    refresh() {
      if (!isOpen || redeeming) return;
      loadUsage(false);
    },

    redeem(target) {
      if (redeeming || disposed) return;
      redeeming = true;
      silenceRedeem = startRedeem(
        client,
        sessionId,
        target,
        (redeem) => update({ redeem }),
        () => {
          redeeming = false;
          // Closed: the counts are stale, and the next open reads everything again.
          if (!isOpen) return;
          // The listed counts are stale now: hide the rows until the new list arrives.
          if (withResets) update({ list: { status: 'loading' } });
          loadUsage(true);
        },
      );
    },

    dismissRedeem() {
      if (state.redeem.status === 'done') update({ redeem: IDLE_REDEEM });
    },

    dispose() {
      disposed = true;
      isOpen = false;
      stopRequests();
      silenceRedeem?.();
      silenceRedeem = null;
    },
  };
}
