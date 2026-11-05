import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown, Plus, Settings, Trash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Session, Workspace } from '@nanachi/shared';
import { createApiClient } from '../api.js';
import { StatusDot } from '../components/StatusDot.js';
import { NewSessionSheet } from '../components/NewSessionSheet.js';
import type { ConnectionStatus } from '../connection.js';
import type { Machine, StorageLike } from '../machines.js';
import type { Route } from '../navigation.js';
import { STATUS_LOOK } from '../screens/MainScreen.js';
import { useAsync } from '../useAsync.js';
import { ForceUpdateAction } from '../updates/ForceUpdateAction.js';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ListPaneView } from './ListPaneView.js';
import { selectionOf } from './sessionTree.js';
import type { MachineTree } from './useMachineTree.js';

interface ListPaneProps {
  machines: readonly Machine[];
  selected: Machine;
  statuses: Readonly<Record<string, ConnectionStatus>>;
  /** The selected machine's workspaces and sessions (loaded by the layout, which the empty screen reads too). */
  tree: MachineTree;
  storage: StorageLike;
  /** The screen in the right pane, to mark its row. */
  route: Route;
  onSelectMachine(id: string): void;
  onAddMachine(): void;
  onRemoveMachine(machine: Machine): void;
  onRepair(machine: Machine): void;
  onOpenSettings(): void;
  /** Shows a screen in the right pane. */
  onOpen(route: Route): void;
}

/** The machine's name with the others (and "add" / "remove") in a menu, and the settings button. */
function ListPaneHeader({
  machines,
  selected,
  statuses,
  onSelectMachine,
  onAddMachine,
  onRemoveMachine,
  onOpenSettings,
}: Pick<
  ListPaneProps,
  'machines' | 'selected' | 'statuses' | 'onSelectMachine' | 'onAddMachine' | 'onRemoveMachine' | 'onOpenSettings'
>) {
  const { t } = useTranslation('machines');
  const { t: tw } = useTranslation('wide');
  const look = STATUS_LOOK[statuses[selected.id] ?? 'connecting'];

  return (
    <header className="flex h-14 shrink-0 items-center gap-0.5 pr-2 pl-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            data-slot="machine-switcher"
            aria-label={`${selected.name}: ${tw('list.machines')}`}
            title={tw('list.machines')}
            className="h-9 min-w-0 flex-1 justify-start gap-2 px-2 text-base font-semibold tracking-tight"
          >
            <StatusDot tone={look.tone} pulse={look.pulse} />
            <span className="truncate">{selected.name}</span>
            <ChevronsUpDown className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          <DropdownMenuRadioGroup value={selected.id} onValueChange={onSelectMachine}>
            {machines.map((machine) => {
              const status = STATUS_LOOK[statuses[machine.id] ?? 'connecting'];
              return (
                <DropdownMenuRadioItem key={machine.id} value={machine.id}>
                  <StatusDot tone={status.tone} pulse={status.pulse} />
                  <span className="truncate">{machine.name}</span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onAddMachine}>
            <Plus aria-hidden="true" />
            {t('main.addMachine')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => onRemoveMachine(selected)}>
            <Trash aria-hidden="true" />
            {t('main.removeMachine')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ForceUpdateAction className="size-9" />
      <Button
        variant="ghost"
        size="icon"
        className="size-9"
        aria-label={t('main.settings')}
        title={t('main.settings')}
        onClick={onOpenSettings}
      >
        <Settings aria-hidden="true" />
      </Button>
    </header>
  );
}

/**
 * The left pane of the wide layout: the selected machine's workspaces and their sessions, kept current by the
 * machine's connection, with a switcher for the other machines. Picking a row shows that screen in the right pane.
 */
export function ListPane({
  machines,
  selected,
  statuses,
  tree,
  storage,
  route,
  onSelectMachine,
  onAddMachine,
  onRemoveMachine,
  onRepair,
  onOpenSettings,
  onOpen,
}: ListPaneProps) {
  const api = useMemo(
    () => createApiClient({ baseUrl: selected.baseUrl, token: selected.token }),
    [selected.baseUrl, selected.token],
  );
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const agentLabels = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent.label])),
    [agents.data],
  );
  const [creatingIn, setCreatingIn] = useState<Workspace | null>(null);

  // A workspace added or removed in the right pane: the screen that did it is left, so the list asks the machine again.
  const previousKind = useRef(route.kind);
  const { reload } = tree;
  useEffect(() => {
    const previous = previousKind.current;
    previousKind.current = route.kind;
    if (previous !== route.kind && (previous === 'folders' || previous === 'workspaces')) reload();
  }, [route.kind, reload]);

  // The window comes back to the front: the machine may have changed while nothing was listening.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [reload]);

  function openSession(workspace: Workspace, session: Session): void {
    onOpen({ kind: 'chat', workspace, session });
  }

  return (
    <>
      <ListPaneView
        header={
          <ListPaneHeader
            machines={machines}
            selected={selected}
            statuses={statuses}
            onSelectMachine={onSelectMachine}
            onAddMachine={onAddMachine}
            onRemoveMachine={onRemoveMachine}
            onOpenSettings={onOpenSettings}
          />
        }
        nodes={tree.nodes}
        error={tree.error}
        selection={selectionOf(route)}
        agentLabels={agentLabels}
        now={Date.now()}
        onOpenWorkspace={(workspace) => onOpen({ kind: 'sessions', workspace })}
        onOpenSession={openSession}
        onNewSession={setCreatingIn}
        onAddWorkspace={() => onOpen({ kind: 'folders' })}
        onRepair={() => onRepair(selected)}
      />

      {creatingIn !== null && (
        <NewSessionSheet
          api={api}
          storage={storage}
          workspace={creatingIn}
          onClose={() => setCreatingIn(null)}
          onCreated={(session) => {
            setCreatingIn(null);
            openSession(creatingIn, session);
          }}
        />
      )}
    </>
  );
}
