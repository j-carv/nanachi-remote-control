import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { createApiClient } from '../api.js';
import type { Connection, ConnectionStatus } from '../connection.js';
import type { Machine, StorageLike } from '../machines.js';
import { activeRoute, type NavState, type Navigator, type Route } from '../navigation.js';
import { AppFrame } from './AppFrame.js';
import { EmptyDetail } from './EmptyDetail.js';
import { allowsSidePane, detailKey, keepsBackOnWide, type LayoutMode } from './layout.js';
import { BackAffordanceContext } from './layoutContext.js';
import { ListPane } from './ListPane.js';
import { useMachineTree } from './useMachineTree.js';
import { useSidePane } from './useSidePane.js';

interface WideLayoutProps {
  mode: Exclude<LayoutMode, 'phone'>;
  nav: NavState;
  router: Navigator;
  machines: readonly Machine[];
  selected: Machine;
  statuses: Readonly<Record<string, ConnectionStatus>>;
  connection: Connection | undefined;
  storage: StorageLike;
  onSelectMachine(id: string): void;
  onAddMachine(): void;
  onRemoveMachine(machine: Machine): void;
  onRepair(machine: Machine): void;
  /** Shows a screen picked in the list: it replaces whatever the right pane had. */
  onPick(route: Route): void;
  /** The screen of a route, drawn with the navigator it should use (the main pane's or the third pane's). */
  renderScreen(route: Route, navigator: Navigator): ReactNode;
}

/**
 * The wide layout of one machine: the list pane, the active screen and, from 1280 px, the third pane. Remounted when
 * another machine is selected, so the list starts clean.
 */
export function WideLayout({
  mode,
  nav,
  router,
  machines,
  selected,
  statuses,
  connection,
  storage,
  onSelectMachine,
  onAddMachine,
  onRemoveMachine,
  onRepair,
  onPick,
  renderScreen,
}: WideLayoutProps) {
  const { t } = useTranslation('wide');
  const route = activeRoute(nav);
  const api = useMemo(
    () => createApiClient({ baseUrl: selected.baseUrl, token: selected.token }),
    [selected.baseUrl, selected.token],
  );
  const tree = useMachineTree(api, connection, statuses[selected.id]);
  const side = useSidePane(route, allowsSidePane(mode));
  // A destination (a conversation, a workspace, settings) opened from inside a screen replaces what the right pane
  // showed, like a pick in the list; a screen that sits on top of another one (changes, files, devices) is pushed.
  const paneRouter: Navigator = {
    push: (next) => (keepsBackOnWide(next) ? router.push(next) : onPick(next)),
    back: () => router.back(),
    replace: (next) => router.replace(next),
  };

  const detail =
    route.kind === 'home' ? (
      <EmptyDetail
        status={statuses[selected.id] ?? 'connecting'}
        nodes={tree.nodes}
        onOpenWorkspaces={() => onPick({ kind: 'workspaces' })}
        onAddWorkspace={() => onPick({ kind: 'folders' })}
        onRepair={() => onRepair(selected)}
      />
    ) : (
      renderScreen(route, side.mainNavigator(paneRouter))
    );

  return (
    <AppFrame
      mode={mode}
      detailKey={detailKey(route)}
      sideLabel={t('side.label')}
      listPane={
        <ListPane
          machines={machines}
          selected={selected}
          statuses={statuses}
          tree={tree}
          storage={storage}
          route={route}
          onSelectMachine={onSelectMachine}
          onAddMachine={onAddMachine}
          onRemoveMachine={onRemoveMachine}
          onRepair={onRepair}
          onOpenSettings={() => onPick({ kind: 'settings' })}
          onOpen={onPick}
        />
      }
      side={
        side.route === null ? null : (
          <BackAffordanceContext.Provider value={side.affordance}>
            {renderScreen(side.route, side.paneNavigator)}
          </BackAffordanceContext.Provider>
        )
      }
    >
      <BackAffordanceContext.Provider value={keepsBackOnWide(route) ? 'back' : 'none'}>{detail}</BackAffordanceContext.Provider>
    </AppFrame>
  );
}
