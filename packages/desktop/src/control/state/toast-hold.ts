import { useEffect } from 'react';
import { createCounter } from './counter.js';

/**
 * While the sessions view (the PWA) is on screen, main draws it over the whole content area, where the toasts sit, so the
 * toasts wait: they stay queued and show, as new, when the view is gone. Asking the view to shrink or step aside for a toast
 * would move the PWA under the user's hands for a few seconds each time.
 */
const holds = createCounter();

/** Holds the toasts back. Returns the function that lets them show; calling it twice counts once. */
export const holdToasts = holds.acquire;

export const toastsHeld = holds.active;

/** True while the toasts wait. */
export const useToastsHeld = holds.useActive;

/** Holds the toasts back for as long as `hold` is true. */
export function useHoldToasts(hold: boolean): void {
  useEffect(() => (hold ? holdToasts() : undefined), [hold]);
}
