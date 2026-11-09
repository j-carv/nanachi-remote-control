import type { Route } from '../navigation.js';

/**
 * Layout by viewport. The phone layout is the one the app was built for and stays the default below 900 px wide or
 * 500 px tall; from 900 px a list pane sits beside the screen, and from 1280 px the chat can open files, changes and
 * the terminal in a third pane. The height floor keeps the largest iPhones turned to landscape (932 x 430 and
 * 956 x 440 CSS px) on the phone layout, which is the one that fits a screen that short. The two media queries are
 * also the Tailwind variants `wide` and `wider` in `styles.css`; `layout.test.ts` keeps the places in step.
 */
export const WIDE_MIN_WIDTH = 900;
export const THREE_PANE_MIN_WIDTH = 1280;
export const WIDE_MIN_HEIGHT = 500;

export type LayoutMode = 'phone' | 'two-pane' | 'three-pane';

/** Media queries for the two layouts (the same ones the `wide:` and `wider:` CSS variants use). */
export const WIDE_QUERY = `(min-width: ${WIDE_MIN_WIDTH}px) and (min-height: ${WIDE_MIN_HEIGHT}px)`;
export const THREE_PANE_QUERY = `(min-width: ${THREE_PANE_MIN_WIDTH}px) and (min-height: ${WIDE_MIN_HEIGHT}px)`;
/**
 * A mouse or trackpad, not a finger: Enter sends the message only then (a phone's or an iPad's on-screen return key is
 * a new line). It does not depend on the width: a narrow desktop window still has a keyboard.
 */
export const ENTER_SENDS_QUERY = '(hover: hover) and (pointer: fine)';

export function layoutModeForViewport(width: number, height: number): LayoutMode {
  if (height < WIDE_MIN_HEIGHT) return 'phone';
  if (width >= THREE_PANE_MIN_WIDTH) return 'three-pane';
  if (width >= WIDE_MIN_WIDTH) return 'two-pane';
  return 'phone';
}

/** The same choice from the two media queries (what the browser tells the hook). */
export function layoutModeFromMatches(wide: boolean, threePane: boolean): LayoutMode {
  if (wide && threePane) return 'three-pane';
  return wide ? 'two-pane' : 'phone';
}

/** The list of machines, workspaces and sessions beside the screen. */
export function hasListPane(mode: LayoutMode): boolean {
  return mode !== 'phone';
}

/** The chat can open files, changes and the terminal beside it instead of over it. */
export function allowsSidePane(mode: LayoutMode): boolean {
  return mode === 'three-pane';
}

/**
 * Whether a screen keeps its back button when the list pane is on screen. Chat, a workspace's sessions, workspaces and
 * settings are reached by picking something in the list, so there is nowhere "back" to go; the screens that open on top
 * of another one keep it.
 */
export function keepsBackOnWide(route: Route): boolean {
  switch (route.kind) {
    case 'changes':
    case 'commits':
    case 'commit':
    case 'files':
    case 'editor':
    case 'devices':
    case 'folders':
    case 'pair':
      return true;
    case 'home':
    case 'settings':
    case 'workspaces':
    case 'sessions':
    case 'schedules':
    case 'chat':
      return false;
  }
}

/** Identifies the screen in the right pane: a pick that shows another screen starts it scrolled to the top. */
export function detailKey(route: Route): string {
  switch (route.kind) {
    case 'chat':
    case 'changes':
    case 'commits':
      return `${route.kind}:${route.session.id}`;
    case 'commit':
      return `commit:${route.session.id}:${route.hash}`;
    case 'sessions':
    case 'schedules':
      return `${route.kind}:${route.workspace.id}`;
    case 'files':
    case 'editor':
      return `${route.kind}:${route.workspace.id}:${route.path}`;
    case 'home':
    case 'pair':
    case 'settings':
    case 'workspaces':
    case 'folders':
    case 'devices':
      return route.kind;
  }
}

/** What the corner button of a screen's header does. */
export type BackAffordance = 'back' | 'close' | 'none';

export interface EscapeContext {
  /** Another handler (a dialog, the editor's autocomplete) already used the key. */
  defaultPrevented: boolean;
  /** Focus is in a text field, the code editor or the terminal, where Escape belongs to the field. */
  inField: boolean;
  /** A dialog or a sheet is open. */
  overlayOpen: boolean;
}

/** Escape closes the third pane only when nothing else wanted the key. */
export function escapeClosesSidePane(context: EscapeContext): boolean {
  return !context.defaultPrevented && !context.inField && !context.overlayOpen;
}

export interface EnterKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  /** An input method (Japanese, Chinese) is still composing: Enter confirms the composition. */
  isComposing: boolean;
}

/** Enter sends the message, Shift+Enter adds a line. Only for a pointer that comes with a keyboard (see ENTER_SENDS_QUERY). */
export function enterSends(event: EnterKey, enabled: boolean): boolean {
  return enabled && event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing;
}
