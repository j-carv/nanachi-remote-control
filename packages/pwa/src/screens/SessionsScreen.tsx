import { useEffect, useState } from 'react';
import { CalendarClock, CircleStop, FolderTree, GitBranch, Plus, RotateCcwClock, SquareTerminal, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import { ListGroup, ListSkeleton, listMainClass, listRowClass, staggerDelay } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { SessionMessageMatches, type MessageMatchRow } from '../components/SessionMessageMatches.js';
import { SessionSearchField } from '../components/SessionSearchField.js';
import { SwipeRow } from '../components/SwipeRow.js';
import { WorkspaceInfoBar } from '../components/WorkspaceInfoBar.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Navigator } from '../navigation.js';
import { formatRelativeTime } from '../relativeTime.js';
import { sessionTitle } from '../sessionText.js';
import { visibleSessions } from '../sessionRemoval.js';
import { filterBySearch, resolveMessageMatches, searchWords } from '../sessionSearch.js';
import { saveMuted } from '../workspace/saveMuted.js';
import { notificationsRow } from '../workspace/workspaceMenuRows.js';
import { useAsync } from '../useAsync.js';
import { useSessionMessageSearch } from '../useSessionMessageSearch.js';

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
  const { t } = useTranslation('workspace');
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
  const [query, setQuery] = useState('');

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

  // The sessions of this workspace narrow at once by name, agent, branch and workspace; the messages are asked for after a pause.
  const searching = searchWords(query).length > 0;
  const search = useSessionMessageSearch(api, query, workspace.id);
  const labelOf = (session: Session): string => sessionTitle(session, agentLabels.get(session.agent) ?? session.agent);
  const shown = searching
    ? filterBySearch(sessions, query, (session) => [
        labelOf(session),
        agentLabels.get(session.agent) ?? session.agent,
        session.worktree?.branch ?? '',
        workspace.name,
      ])
    : sessions;
  const sessionById = new Map(sessions.map((session) => [session.id, session] as const));
  const messageRows: MessageMatchRow[] =
    search.status === 'ready'
      ? resolveMessageMatches(search.results, (id) => sessionById.get(id)).map((match) => ({
          workspace,
          session: match.item,
          label: labelOf(match.item),
          snippet: match.snippet,
          matchedAt: match.matchedAt,
        }))
      : [];

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
      session.worktree !== null && window.confirm(t('sessions.confirmRemoveWorktree'));
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
    const saved = await saveMuted(api, workspace.id, next);
    setMuted(saved.muted);
    setActionError(saved.error);
  }

  return (
    <Screen>
      <ScreenHeader
        title={workspace.name}
        subtitle={`${machineName} · ${workspace.path}`}
        subtitleTruncation="middle"
        onBack={() => nav.back()}
        meta={
          <BranchSwitcher api={api} workspace={workspace} onSwitched={() => info.reload()} />
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('sessions.terminal')}
              title={t('sessions.terminal')}
              onClick={() => setShellOpen(true)}
            >
              <SquareTerminal aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('sessions.files')}
              title={t('sessions.files')}
              onClick={() => nav.push({ kind: 'files', workspace, path: '' })}
            >
              <FolderTree aria-hidden="true" />
            </Button>
            <div data-slot="workspace-schedules-menu">
            <ActionSheetButton
              label={t('sessions.workspaceMenu', { name: workspace.name })}
              title={workspace.name}
              items={[
                { label: t('title', { ns: 'schedules' }), icon: CalendarClock, onSelect: () => nav.push({ kind: 'schedules', workspace }) },
                notificationsRow(muted, (next) => void toggleMuted(next)),
              ]}
            />
            </div>
          </>
        }
      />

      <WorkspaceInfoBar info={info.data} showBranch={false} />

      <div className="flex gap-2">
        <Button className="flex-1" onClick={() => setSheetOpen(true)}>
          <Plus aria-hidden="true" />
          {t('sessions.new')}
        </Button>
        <Button variant="secondary" className="flex-1" onClick={() => setResumeOpen(true)}>
          <RotateCcwClock aria-hidden="true" />
          {t('sessions.resume')}
        </Button>
      </div>

      <SessionSearchField value={query} onChange={setQuery} />

      <ErrorNotice error={error} onRepair={onRepair} />

      {list.data === null && error === null && <ListSkeleton label={t('states.loading', { ns: 'common' })} />}
      {list.data !== null && sessions.length === 0 && (
        <p className="animate-enter pl-1 text-muted-foreground">{t('sessions.empty')}</p>
      )}
      {list.data !== null &&
        sessions.length > 0 &&
        searching &&
        shown.length === 0 &&
        messageRows.length === 0 &&
        (search.status === 'ready' || search.status === 'idle') && (
          <p className="animate-enter pl-1 text-muted-foreground">
            {t('search.noMatches', { ns: 'common', query: query.trim() })}
          </p>
        )}

      {shown.length > 0 && (
        <ListGroup label={t('sessions.listLabel')}>
          {shown.map((session, index) => {
            const label = sessionTitle(session, agentLabels.get(session.agent) ?? session.agent);
            return (
              <li key={session.id} className="animate-enter" style={staggerDelay(index)}>
                <SwipeRow actionLabel={t('sessions.removeFromApp')} onAction={() => setPendingRemoval(session)}>
                  <div className={listRowClass}>
                    <button type="button" className={`${listMainClass} py-1.5`} onClick={() => nav.push({ kind: 'chat', workspace, session })}>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="truncate text-base font-medium">{label}</span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <SessionStatusPill status={session.status} kind={session.kind} />
                          {session.kind === 'pty' && (
                            <Badge variant="outline">
                              <Terminal aria-hidden="true" />
                              {t('terminalBadge')}
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
                          {session.agent === 'shell' ? t('sessions.terminal') : (agentLabels.get(session.agent) ?? session.agent)} ·{' '}
                          {formatRelativeTime(session.updatedAt, now)}
                        </span>
                      </span>
                    </button>
                    {session.status !== 'stopped' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('sessions.stopNamed', { title: label })}
                        onClick={() => void stop(session)}
                      >
                        <CircleStop aria-hidden="true" />
                      </Button>
                    )}
                    <ActionSheetButton
                      label={t('sessions.moreActions', { title: label })}
                      title={label}
                      items={[
                        ...(session.status === 'stopped'
                          ? []
                          : [{ label: t('sessions.stop'), tone: 'danger' as const, onSelect: () => void stop(session) }]),
                        { label: t('sessions.removeFromApp'), tone: 'danger', onSelect: () => setPendingRemoval(session) },
                      ]}
                    />
                  </div>
                </SwipeRow>
              </li>
            );
          })}
        </ListGroup>
      )}

      {searching && (
        <SessionMessageMatches
          state={search}
          rows={messageRows}
          showWorkspace={false}
          selectedSessionId={null}
          now={now}
          onOpen={(row) => nav.push({ kind: 'chat', workspace, session: row.session })}
        />
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
