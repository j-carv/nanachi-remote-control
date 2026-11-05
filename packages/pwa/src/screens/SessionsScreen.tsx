import { useEffect, useState } from 'react';
import { BellOff, Bell, CircleStop, FolderTree, GitBranch, Plus, RotateCcwClock, SquareTerminal, Terminal } from 'lucide-react';
import type { Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import type { Connection } from '../connection.js';
import type { StorageLike } from '../machines.js';
import { BranchSwitcher } from '../components/BranchSwitcher.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { NewSessionSheet } from '../components/NewSessionSheet.js';
import { ActionSheetButton } from '../components/ActionSheet.js';
import { RemoveSessionSheet } from '../components/RemoveSessionSheet.js';
import { ResumeSheet } from '../components/ResumeSheet.js';
import { ShellSheet } from '../components/ShellSheet.js';
import { ListGroup, listMainClass, listRowClass } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { SwipeRow } from '../components/SwipeRow.js';
import { WorkspaceInfoBar } from '../components/WorkspaceInfoBar.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
  const [shellOpen, setShellOpen] = useState(false);
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
    <Screen>
      <ScreenHeader
        title={workspace.name}
        subtitle={`${machineName} · ${workspace.path}`}
        onBack={() => nav.back()}
        meta={
          <BranchSwitcher api={api} workspace={workspace} onSwitched={() => info.reload()} />
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Terminal"
              title="Terminal"
              onClick={() => setShellOpen(true)}
            >
              <SquareTerminal aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Arquivos"
              title="Arquivos"
              onClick={() => nav.push({ kind: 'files', workspace, path: '' })}
            >
              <FolderTree aria-hidden="true" />
            </Button>
          </>
        }
      />

      <WorkspaceInfoBar info={info.data} showBranch={false} />

      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => setSheetOpen(true)}>
          <Plus aria-hidden="true" />
          Nova sessão
        </Button>
        <Button variant="secondary" className="flex-1" onClick={() => setResumeOpen(true)}>
          <RotateCcwClock aria-hidden="true" />
          Retomar do PC
        </Button>
      </div>

      <ListGroup>
        <li className={listRowClass}>
          {muted ? (
            <BellOff className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Bell className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <label htmlFor="workspace-mute" className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base">Silenciar notificações</span>
            <span className="text-sm text-muted-foreground">Não avisa no celular sobre as sessões deste workspace.</span>
          </label>
          <Switch id="workspace-mute" checked={muted} onCheckedChange={(next) => void toggleMuted(next)} />
        </li>
      </ListGroup>

      <ErrorNotice error={error} onRepair={onRepair} />

      {list.data === null && error === null && <p className="pl-1 text-muted-foreground">Carregando…</p>}
      {list.data !== null && sessions.length === 0 && (
        <p className="pl-1 text-muted-foreground">Nenhuma sessão neste workspace ainda.</p>
      )}

      {sessions.length > 0 && (
        <ListGroup label="Sessões">
          {sessions.map((session) => {
            const label = sessionTitle(session, agentLabels.get(session.agent) ?? session.agent);
            return (
              <li key={session.id}>
                <SwipeRow actionLabel="Remover do app" onAction={() => setPendingRemoval(session)}>
                  <div className={listRowClass}>
                    <button type="button" className={`${listMainClass} py-1.5`} onClick={() => nav.push({ kind: 'chat', workspace, session })}>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-base font-medium">{label}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <SessionStatusPill status={session.status} kind={session.kind} />
                          {session.kind === 'pty' && (
                            <Badge variant="outline">
                              <Terminal aria-hidden="true" />
                              terminal
                            </Badge>
                          )}
                          {session.worktree !== null && (
                            <Badge variant="outline" className="font-mono">
                              <GitBranch aria-hidden="true" />
                              {session.worktree.branch}
                            </Badge>
                          )}
                        </span>
                        <span className="truncate text-sm text-muted-foreground">
                          {session.agent === 'shell' ? 'Terminal' : (agentLabels.get(session.agent) ?? session.agent)} ·{' '}
                          {formatRelativeTime(session.updatedAt, now)}
                        </span>
                      </span>
                    </button>
                    {session.status !== 'stopped' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Encerrar ${label}`}
                        onClick={() => void stop(session)}
                      >
                        <CircleStop aria-hidden="true" />
                      </Button>
                    )}
                    <ActionSheetButton
                      label={`Mais ações de ${label}`}
                      title={label}
                      items={[
                        ...(session.status === 'stopped'
                          ? []
                          : [{ label: 'Encerrar', tone: 'danger' as const, onSelect: () => void stop(session) }]),
                        { label: 'Remover do app', tone: 'danger', onSelect: () => setPendingRemoval(session) },
                      ]}
                    />
                  </div>
                </SwipeRow>
              </li>
            );
          })}
        </ListGroup>
      )}

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

      {shellOpen && (
        <ShellSheet
          api={api}
          workspace={workspace}
          onClose={() => setShellOpen(false)}
          onCreated={(session) => {
            setShellOpen(false);
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
    </Screen>
  );
}
