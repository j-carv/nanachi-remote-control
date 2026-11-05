import { createCounter } from './counter.js';

/**
 * Whatever needs the content area for itself while it is on screen: a dialog. The sessions view (the PWA) is a native view
 * that main draws over that area, so it would hide it; the page counts the dialogs here and tells main to step aside
 * (`SessionsViewport.covered`) until none is left. Toasts do not count: they wait instead (`toast-hold.ts`).
 */
const overlays = createCounter();

/** Marks one overlay as on screen. Returns the function that takes it off; calling it twice counts once. */
export const acquireOverlay = overlays.acquire;

export const overlayActive = overlays.active;

/** True while any dialog is on screen. */
export const useOverlayActive = overlays.useActive;
