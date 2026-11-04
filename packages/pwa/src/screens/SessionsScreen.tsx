import { useEffect, useState } from 'react';
import { GitBranch } from '@phosphor-icons/react';
import type { Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import type { Connection } from '../connection.js';
import type { StorageLike } from '../machines.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { NewSessionSheet } from '../components/NewSessionSheet.js';
import { OverflowMenu } from '../components/OverflowMenu.js';
import { RemoveSessionSheet } from '../components/RemoveSessionSheet.js';
import { ResumeSheet } from '../components/ResumeSheet.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { SwipeRow } from '../components/SwipeRow.js';
import { WorkspaceInfoBar } from '../components/WorkspaceInfoBar.js';
import type { Navigator } from '../navigation.js';
import { formatRelativeTime } from '../relativeTime.js';
import { sessionTitle } from '../sessionText.js';
import { visibleSessions } from '../sessionRemoval.js';
import { useAsync } from '../useAsync.js';

interface SessionsScreenProps {
  machineName: string;
  workspace: Workspace;
  api: ApiClient;
  connection: Connection | undefined;
  storage: StorageLike;
  nav: Navigator;
  onRepair(): void;
}

export function SessionsScreen({
  machineName,
  workspace,
  api,
  connection,
  storage,
  nav,
  onRepair,
}: SessionsScreenProps) {
  const list = useAsync(() => api.listSessions(workspace.id), [api, workspace.id]);
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const info = useAsync(() => api.workspaceInfo(workspace.id), [api, workspace.id]);
  const [live, setLive] = useState<Record<string, Session>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [muted, setMuted] = useState(workspace.muted);
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingRemoval, setPendingRemoval] = useState<Session | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(null);

  useEffect(
    () =>
      connection?.onMessage((message) => {
        if (message.type === 'session' && message.session.workspaceId === workspace.id) {
          const session = message.session;
          setLive((previous) => ({ ...previous, [session.id]: session }));
        }
        if (message.type === 'session_removed') {
          const { sessionId } = message;
          setRemovedIds((previous) => new Set(previous).add(sessionId));
        }
      }),
    [connection, workspace.id],
  );

  const error = actionError ?? list.error;
  const sessions = visibleSessions(list.data ?? [], live, removedIds);
  const agentLabels = new Map((agents.data ?? []).map((agent) => [agent.id, agent.label]));
  const now = Date.now();

  /** Remover do app: a sessão some da lista na hora (o servidor também avisa com session_removed). */
  async function removeFromApp(session: Session) {
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await api.deleteSession(session.id, { forget: true });
      setRemovedIds((previous) => new Set(previous).add(session.id));
      setPendingRemoval(null);
    } catch (caught) {
      setRemoveError(caught);
    } finally {
      setRemoveBusy(false);
    }
  }

  async function stop(session: Session) {
    // Worktree próprio da sessão: pergunta se ele vai junto. Sujo, o daemon mantém e avisa.
    const removeWorktree =
      session.worktree !== null && window.confirm('Remover o worktree também?');
    try {
      await api.deleteSession(session.id, { removeWorktree });
      setActionError(null);
    } catch (caught) {
      setActionError(caught);
    }
    list.reload();
  }

  async function toggleMuted(next: boolean) {
    setMuted(next);
    try {
      const updated = await api.updateWorkspace(workspace.id, { muted: next });
      setMuted(updated.muted);
      setActionError(null);
    } catch (caught) {
      setMuted(!next);
      setActionError(caught);
    }
  }

  return (
    <main className="screen">
      <ScreenHeader
        title={workspace.name}
        subtitle={`${machineName} · ${workspace.path}`}
        onBack={() => nav.back()}
      />

      <WorkspaceInfoBar info={info.data} />

      <button type="button" className="button primary" onClick={() => setSheetOpen(true)}>
        + Nova sessão
      </button>

      <button type="button" className="button secondary" onClick={() => setResumeOpen(true)}>
        Retomar do PC
      </button>

      <label className="config-toggle workspace-mute">
        <span>
          <span className="config-name">Silenciar notificações</span>
          <span className="muted small">Não avisa no celular sobre as sessões deste workspace.</span>
        </span>
        <input
          type="checkbox"
          className="switch"
          checked={muted}
          onChange={(event) => void toggleMuted(event.target.checked)}
        />
      </label>

      <ErrorNotice error={error} onRepair={onRepair} />

      {list.data === null && error === null && <p className="muted">Carregando…</p>}
      {list.data !== null && sessions.length === 0 && (
        <p className="muted">Nenhuma sessão neste workspace ainda.</p>
      )}

      <ul className="item-list">
        {sessions.map((session) => {
          const label = sessionTitle(session, agentLabels.get(session.agent) ?? session.agent);
          return (
            <li key={session.id}>
              <SwipeRow actionLabel="Remover do app" onAction={() => setPendingRemoval(session)}>
                <div className="item-row">
                  <button
                    type="button"
                    className="item-main"
                    onClick={() => nav.push({ kind: 'chat', workspace, session })}
                  >
                    <span className="item-title">{label}</span>
                    <span className="item-meta">
                      <SessionStatusPill status={session.status} kind={session.kind} />
                      {session.kind === 'pty' && <span className="badge">terminal</span>}
                      {session.worktree !== null && (
                        <span className="chip chip-branch">
                          <GitBranch size={14} weight="bold" aria-hidden="true" />
                          {session.worktree.branch}
                        </span>
                      )}
                      <span className="muted small">
                        {agentLabels.get(session.agent) ?? session.agent} ·{' '}
                        {formatRelativeTime(session.updatedAt, now)}
                      </span>
                    </span>
                  </button>
                  {session.status !== 'stopped' && (
                    <button type="button" className="button ghost danger" onClick={() => stop(session)}>
                      Encerrar
                    </button>
                  )}
                  <OverflowMenu
                    label={`Mais ações de ${label}`}
                    items={[{ label: 'Remover do app', tone: 'danger', onSelect: () => setPendingRemoval(session) }]}
                  />
                </div>
              </SwipeRow>
            </li>
          );
        })}
      </ul>

      {pendingRemoval !== null && (
        <RemoveSessionSheet
          agentLabel={agentLabels.get(pendingRemoval.agent) ?? pendingRemoval.agent}
          status={pendingRemoval.status}
          busy={removeBusy}
          error={removeError}
          onCancel={() => {
            setPendingRemoval(null);
            setRemoveError(null);
          }}
          onConfirm={() => void removeFromApp(pendingRemoval)}
        />
      )}

      {resumeOpen && (
        <ResumeSheet
          api={api}
          workspace={workspace}
          onClose={() => setResumeOpen(false)}
          onOpen={(session) => {
            setResumeOpen(false);
            nav.push({ kind: 'chat', workspace, session });
          }}
        />
      )}

      {sheetOpen && (
        <NewSessionSheet
          api={api}
          storage={storage}
          workspace={workspace}
          onClose={() => setSheetOpen(false)}
          onCreated={(session) => {
            setSheetOpen(false);
            nav.push({ kind: 'chat', workspace, session });
          }}
        />
      )}
    </main>
  );
}
