/** What the app does with a service worker version that is waiting to take over. */
export type UpdateAction = 'none' | 'show-bar' | 'wait' | 'reload-on-visible';

export interface UpdateInputs {
  /** A newer version is installed and this page is still running the old one. */
  updateWaiting: boolean;
  /** `document.visibilityState`, reduced to the two values this decision needs. */
  visibility: 'visible' | 'hidden';
  /** `isReloadHeld()`: the chat composer has unsent text. */
  reloadHeld: boolean;
  /** An open dialog or drawer is on screen. */
  dialogOpen: boolean;
  /** True only in the visibilitychange event that brings the app back to visible. */
  returning: boolean;
  /** The version arrived while the app was hidden. Set once, when the update first arrives. */
  arrivedInBackground: boolean;
}

/**
 * Decides what to do with a waiting update. Pure: the hook gathers the inputs and performs the action.
 *
 * - No waiting update: nothing.
 * - Unsent text or an open dialog: never reload; show the bar in either visibility state.
 * - Hidden app, nothing held: wait, with no bar.
 * - Visible app, nothing held, returning from background, and the update arrived in the background:
 *   reload now. A version that arrived while visible keeps its bar; the user decides.
 * - Visible app otherwise: show the bar.
 */
export function decideUpdateAction(inputs: UpdateInputs): UpdateAction {
  if (!inputs.updateWaiting) return 'none';
  if (inputs.reloadHeld || inputs.dialogOpen) return 'show-bar';
  if (inputs.visibility === 'hidden') return 'wait';
  return inputs.returning && inputs.arrivedInBackground ? 'reload-on-visible' : 'show-bar';
}
