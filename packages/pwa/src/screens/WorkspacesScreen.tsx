import { useState } from 'react';
import { ChevronRight, Folder, Plus, Trash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, listMainClass, listRowClass } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Button } from '@/components/ui/button';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';

interface WorkspacesScreenProps {
  machineName: string;
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

export function WorkspacesScreen({ machineName, api, nav, onRepair }: WorkspacesScreenProps) {
  const { t } = useTranslation('workspace');
  const list = useAsync(() => api.listWorkspaces(), [api]);
  const [actionError, setActionError] = useState<unknown>(null);
  const error = actionError ?? list.error;

  async function remove(workspace: Workspace) {
    if (!window.confirm(t('workspaces.confirmRemove', { name: workspace.name }))) return;
    try {
      await api.deleteWorkspace(workspace.id);
      setActionError(null);
      list.reload();
    } catch (caught) {
      setActionError(caught);
    }
  }

  const workspaces = list.data;

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

      {workspaces === null && error === null && <p className="pl-1 text-muted-foreground">{t('states.loading', { ns: 'common' })}</p>}
      {workspaces !== null && workspaces.length === 0 && (
        <p className="pl-1 text-muted-foreground">
          {t('workspaces.empty')}
        </p>
      )}

      {workspaces !== null && workspaces.length > 0 && (
        <ListGroup label={t('workspaces.title')}>
          {workspaces.map((workspace) => (
            <li key={workspace.id} className={listRowClass}>
              <button type="button" className={listMainClass} onClick={() => nav.push({ kind: 'sessions', workspace })}>
                <Folder className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-base font-medium">{workspace.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{workspace.path}</span>
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
