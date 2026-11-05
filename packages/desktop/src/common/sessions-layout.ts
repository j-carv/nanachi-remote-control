/**
 * Sizes that the control center and the PWA it embeds have to agree on. No Electron imports: the renderer and the main process
 * both read them.
 */

/**
 * The PWA switches to its wide layout (a list pane beside the screen) from this viewport. Below it the app is the phone's:
 * a window narrower or shorter than this would show the phone layout, and crossing the threshold while a screen is open
 * remounts it. These are the numbers of `packages/pwa/src/wide/layout.ts` (`WIDE_MIN_WIDTH`, `WIDE_MIN_HEIGHT`);
 * `test/control-policy.test.ts` reads that file and fails when they drift.
 */
export const PWA_WIDE_MIN_WIDTH = 900;
export const PWA_WIDE_MIN_HEIGHT = 500;

/** The sidebar as the 64 px icon rail. On the Sessões section it is always the rail, whatever the user saved. */
export const SIDEBAR_RAIL_WIDTH = 64;
