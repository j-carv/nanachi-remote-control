import {
  activeRoute,
  goToDepth,
  initialNav,
  pushNav,
  replaceNav,
  type NavState,
  type Route,
} from '../navigation.js';

/**
 * The third pane of the wide layout. It belongs to one chat (`owner`): files, changes or the terminal opened from that
 * conversation. It keeps its own small stack, so a file opened from the explorer has "back" to the explorer, and the
 * first screen of the stack closes the pane. Nothing here touches the browser history.
 */
export interface SidePane {
  owner: string;
  nav: NavState;
}

/** The key of the chat that owns a side pane, or null for a route that has none (only conversations and terminals do). */
export function sideOwnerKey(route: Route): string | null {
  return route.kind === 'chat' ? `chat:${route.session.id}` : null;
}

/**
 * Whether a route pushed from a conversation opens beside it. Changes, the commit history, the file explorer and the
 * editor always do; a terminal session does when the conversation is an agent chat (a terminal that is already the main
 * screen replaces itself, as on the phone).
 */
export function opensInSidePane(next: Route, current: Route): boolean {
  switch (next.kind) {
    case 'changes':
    case 'commits':
    case 'commit':
    case 'files':
    case 'editor':
      return true;
    case 'chat':
      return next.session.kind === 'pty' && current.kind === 'chat' && current.session.kind === 'acp';
    case 'home':
    case 'pair':
    case 'settings':
    case 'workspaces':
    case 'folders':
    case 'devices':
    case 'sessions':
    case 'schedules':
      return false;
  }
}

/** Opens `route` as the root of a fresh stack for `owner`, replacing whatever the pane showed. */
export function openSidePane(owner: string, route: Route): SidePane {
  return { owner, nav: initialNav(route) };
}

/** The screen the pane shows for the conversation on screen, or null (closed, or open for another conversation). */
export function activeSideRoute(pane: SidePane | null, owner: string | null): Route | null {
  if (pane === null || owner === null || pane.owner !== owner) return null;
  return activeRoute(pane.nav);
}

export function pushSidePane(pane: SidePane | null, route: Route): SidePane | null {
  if (pane === null) return null;
  return { owner: pane.owner, nav: pushNav(pane.nav, route).nav };
}

export function replaceSidePane(pane: SidePane | null, route: Route): SidePane | null {
  if (pane === null) return null;
  return { owner: pane.owner, nav: replaceNav(pane.nav, route) };
}

/** One screen back; from the first screen it closes the pane. */
export function backSidePane(pane: SidePane | null): SidePane | null {
  if (pane === null || pane.nav.index === 0) return null;
  return { owner: pane.owner, nav: goToDepth(pane.nav, pane.nav.index - 1) };
}

/** What the corner button of the pane's screens does: the first screen closes the pane, the next ones go back. */
export function sideBackAffordance(pane: SidePane | null): 'back' | 'close' {
  return pane !== null && pane.nav.index > 0 ? 'back' : 'close';
}
