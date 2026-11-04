import { useState } from 'react';
import type { Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';

interface WorkspacesScreenProps {
  machineName: string;
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

export function WorkspacesScreen({ machineName, api, nav, onRepair }: WorkspacesScreenProps) {
  const list = useAsync(() => api.listWorkspaces(), [api]);
  const [actionError, setActionError] = useState<unknown>(null);
  const error = actionError ?? list.error;

  async function remove(workspace: Workspace) {
    if (!window.confirm(`Remover "${workspace.name}"? As sessões dele são encerradas.`)) return;
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
    <main className="screen">
      <ScreenHeader
        title="Workspaces"
        subtitle={machineName}
        onBack={() => nav.back()}
        actions={
          <button type="button" className="button primary" onClick={() => nav.push({ kind: 'folders' })}>
            + Workspace
          </button>
        }
      />

      <ErrorNotice error={error} onRepair={onRepair} />

      {workspaces === null && error === null && <p className="muted">Carregando…</p>}
      {workspaces !== null && workspaces.length === 0 && (
        <p className="muted">Nenhum workspace ainda. Escolha uma pasta do PC com “+ Workspace”.</p>
      )}

      <ul className="item-list">
        {workspaces?.map((workspace) => (
          <li key={workspace.id} className="item-row">
            <button
              type="button"
              className="item-main"
              onClick={() => nav.push({ kind: 'sessions', workspace })}
            >
              <span className="item-title">{workspace.name}</span>
              <span className="muted small path">{workspace.path}</span>
            </button>
            <button type="button" className="button ghost danger" onClick={() => remove(workspace)}>
              Remover
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
