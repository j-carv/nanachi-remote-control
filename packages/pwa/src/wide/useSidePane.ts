import { useEffect, useMemo, useState } from 'react';
import type { Navigator, Route } from '../navigation.js';
import { escapeClosesSidePane } from './layout.js';
import {
  activeSideRoute,
  backSidePane,
  openSidePane,
  opensInSidePane,
  pushSidePane,
  replaceSidePane,
  sideBackAffordance,
  sideOwnerKey,
  type SidePane,
} from './sidePane.js';

export interface SidePaneController {
  /** The screen the third pane shows, or null when it is closed. */
  route: Route | null;
  affordance: 'back' | 'close';
  /** The navigator of the conversation in the main pane: what it opens beside itself goes to the third pane. */
  mainNavigator(router: Navigator): Navigator;
  /** The navigator of the screens inside the third pane. */
  paneNavigator: Navigator;
}

/** Focus is in the code editor, the terminal or a menu, where Escape belongs to the control. */
function inField(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-editor, .xterm, select, [role="combobox"]') !== null;
}

/** A dialog, a sheet or a menu is open (it closes itself on Escape). */
function overlayOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

/**
 * State of the third pane of the wide layout. It belongs to the conversation on screen: another conversation, or a
 * layout without the pane, closes it. Escape closes it unless a dialog, a field or the editor wants the key.
 */
export function useSidePane(route: Route, enabled: boolean): SidePaneController {
  const owner = enabled ? sideOwnerKey(route) : null;
  const [pane, setPane] = useState<SidePane | null>(null);

  useEffect(() => {
    setPane((current) => (current !== null && current.owner !== owner ? null : current));
  }, [owner]);

  const sideRoute = activeSideRoute(pane, owner);
  const open = sideRoute !== null;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const context = {
        defaultPrevented: event.defaultPrevented,
        inField: inField(event.target),
        overlayOpen: overlayOpen(),
      };
      if (escapeClosesSidePane(context)) setPane(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const paneNavigator = useMemo<Navigator>(
    () => ({
      push: (next) => setPane((current) => pushSidePane(current, next)),
      back: () => setPane((current) => backSidePane(current)),
      replace: (next) => setPane((current) => replaceSidePane(current, next)),
    }),
    [],
  );

  return {
    route: sideRoute,
    affordance: sideBackAffordance(pane),
    mainNavigator: (router) => ({
      push(next) {
        if (owner !== null && opensInSidePane(next, route)) setPane(openSidePane(owner, next));
        else router.push(next);
      },
      back: () => router.back(),
      replace: (next) => router.replace(next),
    }),
    paneNavigator,
  };
}
