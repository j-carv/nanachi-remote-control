import type { ReactNode } from 'react';
import { hasListPane, type LayoutMode } from './layout.js';
import { LayoutContext } from './layoutContext.js';

/** 300 px at 900 px of window, 340 px from 1400 px: a list that grows a little with the window. */
const LIST_PANE_WIDTH = 'clamp(300px, calc(300px + (100vw - 900px) * 0.08), 340px)';

interface AppFrameProps {
  mode: LayoutMode;
  /** The machines, workspaces and sessions. Rendered only on wide screens. */
  listPane: ReactNode;
  /** The third pane (files, changes, terminal of the open chat), or null. Rendered only in three-pane mode. */
  side: ReactNode | null;
  sideLabel: string;
  /** Changes when the screen in the right pane is another one, so its scroll position starts at the top. */
  detailKey: string;
  /** The screen of the active route. */
  children: ReactNode;
}

/**
 * The frame around the active screen. On the phone it is the screen alone, exactly as before. From 900 px the list pane
 * stands on the left and the screen fills the right pane; from 1280 px a third pane can sit beside the screen.
 */
export function AppFrame({ mode, listPane, side, sideLabel, detailKey, children }: AppFrameProps) {
  if (!hasListPane(mode)) return <>{children}</>;

  return (
    <LayoutContext.Provider value={mode}>
      <div data-slot="wide-shell" data-layout={mode} className="fixed inset-0 flex bg-background text-foreground">
        <aside
          data-slot="list-pane-frame"
          style={{ width: LIST_PANE_WIDTH }}
          className="h-full shrink-0 border-r border-border bg-card"
        >
          {listPane}
        </aside>
        <div className="flex min-w-0 flex-1">
          <div key={detailKey} data-slot="detail-pane" className="relative min-w-0 flex-1 overflow-y-auto">
            {children}
          </div>
          {mode === 'three-pane' && side !== null && (
            <aside
              data-slot="side-pane"
              data-pane="side"
              aria-label={sideLabel}
              className="relative w-[clamp(380px,40%,640px)] shrink-0 overflow-y-auto border-l border-border bg-background"
            >
              {side}
            </aside>
          )}
        </div>
      </div>
    </LayoutContext.Provider>
  );
}
