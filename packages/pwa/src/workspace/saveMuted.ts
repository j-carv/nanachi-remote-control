import type { ApiClient } from '../api.js';

export interface MuteResult {
  /** The state to show once the save ends: the one the machine kept, or the one before the pick when the save failed. */
  muted: boolean;
  /** The error of the failed save, or `null` when it went through. */
  error: unknown;
}

/**
 * Saves a workspace's notifications state. The screen shows `next` while the request is in flight; the result says what to
 * show when it ends. A pick always flips the state, so the state before a failed pick is `!next`.
 */
export async function saveMuted(
  api: Pick<ApiClient, 'updateWorkspace'>,
  workspaceId: string,
  next: boolean,
): Promise<MuteResult> {
  try {
    const updated = await api.updateWorkspace(workspaceId, { muted: next });
    return { muted: updated.muted, error: null };
  } catch (caught) {
    return { muted: !next, error: caught };
  }
}
