import { useState } from 'react';
import { ChevronRight, Folder, Plus, ShieldExclamationPoint, Trash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import type { Connection, ConnectionStatus } from '../connection.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton, listMainClass, listRowClass, staggerDelay } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { StatusDot, TONE_TEXT } from '../components/StatusDot.js';
import type { SessionCounts } from '../machineOverview.js';
import type { Navigator } from '../navigation.js';
import { useMachineTree } from '../wide/useMachineTree.js';
import { activityParts } from '../workspace/activity.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface WorkspacesScreenProps {
  machineName: string;
  api: ApiClient;
  /** The machine's connection and status: the counts on the rows follow its `session` messages, as the list pane's do. */
  connection: Connection | undefined;
  status: ConnectionStatus | undefined;
  nav: Navigator;
  onRepair(): void;
}

/** Sessions running and waiting for permission under a workspace's name. Nothing is shown for a count of zero. */
export function ActivityLine({ counts }: { counts: SessionCounts }) {
  const { t } = useTranslation('machines');
  const parts = activityParts(counts);
  if (parts.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
      {parts.map((part) =>
        part.kind === 'running' ? (
          <span key={part.kind} className="flex items-center gap-1.5">
            <StatusDot tone="running" />
            {t('summary.running', { count: part.count })}
          </span>
        ) : (
          <span key={part.kind} className={cn('flex items-center gap-1 font-medium', TONE_TEXT.attention)}>
            <ShieldExclamationPoint className="size-4" aria-hidden="true" />
            {t('summary.awaiting', { count: part.count })}
          </span>
        ),
      )}
    </span>
  );
}

export function WorkspacesScreen({ machineName, api, connection, status, nav, onRepair }: WorkspacesScreenProps) {
  const { t } = useTranslation('workspace');
  // The same data path as the wide list pane: the workspaces with their sessions, kept current by the connection.
  const tree = useMachineTree(api, connection, status);
  const [actionError, setActionError] = useState<unknown>(null);
  const error = actionError ?? tree.error;

  async function remove(workspace: Workspace) {
    if (!window.confirm(t('workspaces.confirmRemove', { name: workspace.name }))) return;
    try {
      await api.deleteWorkspace(workspace.id);
      setActionError(null);
      tree.reload();
    } catch (caught) {
      setActionError(caught);
    }
  }

  const nodes = tree.nodes;

  return (
    <Screen>
      <ScreenHeader
        title={t('workspaces.title')}
        subtitle={machineName}
        onBack={() => nav.back()}
        actions={
          <Button variant="ghost" size="icon" aria-label={t('workspaces.add')} onClick={() => nav.push({ kind: 'folders' })}>
            <Plus aria-hidden="true" />
          </Button>
        }
      />

      <ErrorNotice error={error} onRepair={onRepair} />

      {nodes === null && error === null && <ListSkeleton label={t('states.loading', { ns: 'common' })} />}
      {nodes !== null && nodes.length === 0 && (
        <p className="animate-enter pl-1 text-muted-foreground">
          {t('workspaces.empty')}
        </p>
      )}

      {nodes !== null && nodes.length > 0 && (
        <ListGroup label={t('workspaces.title')}>
          {nodes.map(({ workspace, counts }, index) => (
            <li key={workspace.id} className={`${listRowClass} animate-enter`} style={staggerDelay(index)}>
              <button type="button" className={listMainClass} onClick={() => nav.push({ kind: 'sessions', workspace })}>
                <Folder className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-base font-medium">{workspace.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{workspace.path}</span>
                  <ActivityLine counts={counts} />
                </span>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive"
                aria-label={t('workspaces.remove', { name: workspace.name })}
                onClick={() => void remove(workspace)}
              >
                <Trash aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ListGroup>
      )}
    </Screen>
  );
}
