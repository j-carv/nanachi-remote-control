/**
 * What the folders editor asks main to do when the user presses save, and how it understands the answer. Pure: the
 * store and the section only call these, so the rules (when edits survive, what a count of busy sessions means, what each
 * result tells the user) are testable without a window.
 */
import type { ControlApi, ControlError, FoldersState, SaveRootsResult } from '../../common/control-api.js';
import type { DaemonStatus } from '../../common/types.js';
import type { ControlT } from '../i18n.js';
import { settle } from '../state/resource-core.js';
import type { ToastInput } from '../ui/Toast.js';

/**
 * `auto`: the first press; main restarts and decides by itself whether it has to ask first.
 * `now`: the user read the dialog and agreed to interrupt `shownBusy` sessions.
 * `later`: save only; the daemon keeps running with the old list until it restarts.
 */
export type SaveChoice = 'auto' | 'now' | 'later';

export interface SavePlan {
  restart: boolean;
  /** The sessions the user agreed to interrupt; absent when no one was asked. */
  confirmedBusy?: number;
}

export function planSave(choice: SaveChoice, shownBusy: number): SavePlan {
  if (choice === 'later') return { restart: false };
  if (choice === 'now') return { restart: true, confirmedBusy: shownBusy };
  return { restart: true };
}

export type SaveOutcome =
  | { kind: 'saved'; applied: Exclude<SaveRootsResult['applied'], 'needs_confirmation'>; state: FoldersState }
  /** Nothing was saved or restarted: `busySessions` (read just now) would be interrupted and the user did not agree to that many. */
  | { kind: 'needs_confirmation'; busySessions: number; state: FoldersState }
  | { kind: 'failed'; error: ControlError }
  /** The user threw the edits away. */
  | { kind: 'discarded' };

export function saveOutcome(result: { ok: true; value: SaveRootsResult } | ControlError): SaveOutcome {
  if (!result.ok) return { kind: 'failed', error: result };
  const { applied, state } = result.value;
  if (applied === 'needs_confirmation') return { kind: 'needs_confirmation', busySessions: state.busySessions, state };
  return { kind: 'saved', applied, state };
}

/** The edits on screen after an outcome: gone once saved or discarded, kept when nothing was saved. */
export function draftAfter(outcome: SaveOutcome, draft: string[] | null): string[] | null {
  return outcome.kind === 'saved' || outcome.kind === 'discarded' ? null : draft;
}

/** Calls main and understands what came back. A rejected call is a failure, never a thrown error. */
export async function saveFolders(api: ControlApi, paths: string[], plan: SavePlan): Promise<SaveOutcome> {
  const result = await settle(() => (plan.confirmedBusy === undefined ? api.folders.save(paths, plan.restart) : api.folders.save(paths, plan.restart, plan.confirmedBusy)));
  return saveOutcome(result);
}

export function savedMessage(applied: Exclude<SaveRootsResult['applied'], 'needs_confirmation'>, t: ControlT): ToastInput {
  switch (applied) {
    case 'restarted':
      return { tone: 'success', message: t('folders.saved.restarted') };
    case 'starting':
      return { tone: 'info', message: t('folders.saved.starting') };
    case 'restart_failed':
      return { tone: 'error', title: t('folders.saved.restartFailedTitle'), message: t('folders.saved.restartFailed') };
    case 'pending':
      return { tone: 'success', message: t('folders.saved.pending') };
  }
}

/** What a plain restart (no list involved) tells the user, from the status main answered. */
export function restartedMessage(status: DaemonStatus, t: ControlT): ToastInput {
  if (status.state === 'starting') return { tone: 'info', message: t('restart.starting') };
  return { tone: 'success', message: t('restart.done') };
}
