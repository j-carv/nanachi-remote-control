import { createContext, useContext, useSyncExternalStore } from 'react';
import {
  layoutModeFromMatches,
  THREE_PANE_QUERY,
  WIDE_QUERY,
  type BackAffordance,
  type LayoutMode,
} from './layout.js';

/** The layout the screens below are drawn in. Phone unless a wide shell says otherwise (tests and the pairing screen are phone). */
export const LayoutContext = createContext<LayoutMode>('phone');

export function useLayout(): LayoutMode {
  return useContext(LayoutContext);
}

/** What the corner button in a screen's header does. `back` is the phone's chevron. */
export const BackAffordanceContext = createContext<BackAffordance>('back');

export function useBackAffordance(): BackAffordance {
  return useContext(BackAffordanceContext);
}

function subscribe(notify: () => void): () => void {
  const lists = [window.matchMedia(WIDE_QUERY), window.matchMedia(THREE_PANE_QUERY)];
  for (const list of lists) list.addEventListener('change', notify);
  return () => {
    for (const list of lists) list.removeEventListener('change', notify);
  };
}

function snapshot(): LayoutMode {
  return layoutModeFromMatches(window.matchMedia(WIDE_QUERY).matches, window.matchMedia(THREE_PANE_QUERY).matches);
}

/** The layout for the width of the window now, following resizes (a window dragged across 900 px, an iPad turned). */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, snapshot, () => 'phone');
}
