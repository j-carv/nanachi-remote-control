import { useState, type ReactNode } from 'react';
import { ChevronRight, Folder, FolderOpen, LoaderCircle, Plus, ShieldExclamationPoint, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Session, SessionStatus, Workspace } from '@nanachi/shared';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { StatusDot, TONE_TEXT, type StatusTone } from '../components/StatusDot.js';
import { sessionGroup } from '../machineOverview.js';
import { formatRelativeTime } from '../relativeTime.js';
import { sessionTitle } from '../sessionText.js';
import {
  SESSION_ROW_LIMIT,
  summarizeTree,
  visibleSessionRows,
  type Selection,
  type WorkspaceNode,
} from './sessionTree.js';

/** Tone of a session's dot in the list: the same ones as the status pill and the phone's home. */
const ROW_TONE: Record<SessionStatus, StatusTone> = {
  starting: 'muted',
  idle: 'muted',
  running: 'running',
  awaiting_permission: 'attention',
  stopped: 'muted',
  error: 'danger',
};

export interface ListPaneViewProps {
  /** Machine switcher and the pane's buttons. */
  header: ReactNode;
  /** Null until the first load answers. */
  nodes: readonly WorkspaceNode[] | null;
  error: unknown;
  selection: Selection;
  /** Agent id to label, for the title of a terminal session. */
  agentLabels: ReadonlyMap<string, string>;
  /** Epoch ms for the relative times. */
  now: number;
  onOpenWorkspace(workspace: Workspace): void;
  onOpenSession(workspace: Workspace, session: Session): void;
  onNewSession(workspace: Workspace): void;
  onAddWorkspace(): void;
  onRepair(): void;
}

function SessionIcon({ status }: { status: SessionStatus }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
      {status === 'running' ? (
        <LoaderCircle className={cn('size-4 animate-spin motion-reduce:animate-none', TONE_TEXT.running)} />
      ) : (
        <StatusDot tone={ROW_TONE[status]} pulse={status === 'starting'} />
      )}
    </span>
  );
}

function SessionRow({
  session,
  label,
  selected,
  now,
  onOpen,
}: {
  session: Session;
  label: string;
  selected: boolean;
  now: number;
  onOpen(): void;
}) {
  const { t } = useTranslation('machines');
  const awaiting = sessionGroup(session.status) === 'awaiting';
  return (
    <li>
      <button
        type="button"
        data-slot="list-session"
        data-status={session.status}
        data-kind={session.kind}
        aria-current={selected ? 'page' : undefined}
        title={label}
        onClick={onOpen}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          selected && 'bg-accent',
        )}
      >
        <SessionIcon status={session.status} />
        <span className={cn('min-w-0 flex-1 truncate text-[15px]', (awaiting || selected) && 'font-medium')}>{label}</span>
        {session.kind === 'pty' && <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        {awaiting ? (
          <span className={cn('flex shrink-0 items-center', TONE_TEXT.attention)}>
            <ShieldExclamationPoint className="size-4" aria-hidden="true" />
            <span className="sr-only">{t('card.awaitingPermission')}</span>
          </span>
        ) : (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatRelativeTime(session.updatedAt, now)}</span>
        )}
      </button>
    </li>
  );
}

function WorkspaceGroup({
  node,
  selection,
  collapsed,
  expanded,
  agentLabels,
  now,
  onToggle,
  onExpand,
  onOpenWorkspace,
  onOpenSession,
  onNewSession,
}: {
  node: WorkspaceNode;
  selection: Selection;
  collapsed: boolean;
  expanded: boolean;
  agentLabels: ReadonlyMap<string, string>;
  now: number;
  onToggle(): void;
  onExpand(): void;
  onOpenWorkspace(workspace: Workspace): void;
  onOpenSession(workspace: Workspace, session: Session): void;
  onNewSession(workspace: Workspace): void;
}) {
  const { t } = useTranslation('wide');
  const { workspace } = node;
  const selectedWorkspace = selection.workspaceId === workspace.id && selection.sessionId === null;
  const { rows, hidden } = visibleSessionRows(node.sessions, { expanded, pinned: selection.sessionId });
  const showToggle = expanded ? node.sessions.length > SESSION_ROW_LIMIT : hidden > 0;

  return (
    <li data-slot="list-workspace" data-workspace={workspace.id}>
      <div
        className={cn(
          'group/ws flex items-center rounded-md transition-colors hover:bg-accent/60',
          selectedWorkspace && 'bg-accent hover:bg-accent',
        )}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? 'list.expand' : 'list.collapse', { name: workspace.name })}
          title={t(collapsed ? 'list.expand' : 'list.collapse', { name: workspace.name })}
          onClick={onToggle}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn('size-4 transition-transform duration-200 motion-reduce:transition-none', !collapsed && 'rotate-90')}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          data-slot="list-workspace-open"
          aria-current={selectedWorkspace ? 'page' : undefined}
          title={workspace.path}
          onClick={() => onOpenWorkspace(workspace)}
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate text-[15px] font-medium">{workspace.name}</span>
          {collapsed && node.counts.awaiting > 0 && (
            <ShieldExclamationPoint className={cn('size-4 shrink-0', TONE_TEXT.attention)} aria-hidden="true" />
          )}
        </button>
        <Button
          variant="ghost"
          size="icon"
          data-slot="list-new-session"
          className="mr-0.5 size-8 text-muted-foreground opacity-0 group-focus-within/ws:opacity-100 group-hover/ws:opacity-100 pointer-coarse:opacity-100"
          aria-label={t('list.newSessionIn', { name: workspace.name })}
          title={t('list.newSessionIn', { name: workspace.name })}
          onClick={() => onNewSession(workspace)}
        >
          <Plus className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {!collapsed && (
        <div className="mt-0.5 ml-[15px] border-l border-border pl-1.5">
          {node.sessions.length === 0 ? (
            <p className="flex h-8 items-center pl-2 text-sm text-muted-foreground">{t('list.noSessions')}</p>
          ) : (
            <ul aria-label={t('list.sessionsOf', { name: workspace.name })} className="flex flex-col gap-px">
              {rows.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  label={sessionTitle(session, agentLabels.get(session.agent) ?? session.agent)}
                  selected={selection.sessionId === session.id}
                  now={now}
                  onOpen={() => onOpenSession(workspace, session)}
                />
              ))}
            </ul>
          )}
          {showToggle && (
            <button
              type="button"
              onClick={onExpand}
              className="mt-0.5 flex h-8 w-full items-center rounded-md pl-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? t('list.showLess') : t('list.showMore', { count: hidden })}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The list pane without its data fetching: the pane's header, a line of totals, and the workspaces of the machine with
 * their sessions. Each workspace folds; a long list of sessions shows its first rows and "Mostrar mais".
 */
export function ListPaneView({
  header,
  nodes,
  error,
  selection,
  agentLabels,
  now,
  onOpenWorkspace,
  onOpenSession,
  onNewSession,
  onAddWorkspace,
  onRepair,
}: ListPaneViewProps) {
  const { t } = useTranslation('wide');
  const { t: tm } = useTranslation('machines');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const summary = nodes === null ? null : summarizeTree(nodes);

  function flip(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  return (
    <nav aria-label={t('list.label')} data-slot="list-pane" className="flex h-full min-h-0 flex-col">
      {header}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
        {summary !== null && (summary.running > 0 || summary.awaiting > 0) && (
          <SummaryLine
            running={summary.running}
            awaiting={summary.awaiting}
            onOpenAwaiting={
              summary.awaitingTarget === null
                ? undefined
                : () => {
                    if (summary.awaitingTarget !== null) onOpenSession(summary.awaitingTarget.workspace, summary.awaitingTarget.session);
                  }
            }
          />
        )}

        <div className="flex items-center justify-between pt-3 pr-0.5 pb-1 pl-2">
          <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <FolderOpen className="size-4" aria-hidden="true" />
            {tm('main.workspaces')}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label={t('workspaces.add', { ns: 'workspace' })}
            title={t('workspaces.add', { ns: 'workspace' })}
            onClick={onAddWorkspace}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {error !== null && (
          <div className="px-1 pb-2">
            <ErrorNotice error={error} onRepair={onRepair} />
          </div>
        )}

        {nodes === null && error === null && (
          <p className="px-2 py-2 text-sm text-muted-foreground">{t('states.loading', { ns: 'common' })}</p>
        )}
        {nodes !== null && nodes.length === 0 && (
          <p className="px-2 py-2 text-sm text-muted-foreground">{t('list.noWorkspaces')}</p>
        )}

        {nodes !== null && nodes.length > 0 && (
          <ul className="flex flex-col gap-1">
            {nodes.map((node) => (
              <WorkspaceGroup
                key={node.workspace.id}
                node={node}
                selection={selection}
                collapsed={collapsed.has(node.workspace.id)}
                expanded={expanded.has(node.workspace.id)}
                agentLabels={agentLabels}
                now={now}
                onToggle={() => setCollapsed((previous) => flip(previous, node.workspace.id))}
                onExpand={() => setExpanded((previous) => flip(previous, node.workspace.id))}
                onOpenWorkspace={onOpenWorkspace}
                onOpenSession={onOpenSession}
                onNewSession={onNewSession}
              />
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

/** "2 rodando · 1 aguardando você": the totals of the machine, the waiting part jumps to that session. */
function SummaryLine({
  running,
  awaiting,
  onOpenAwaiting,
}: {
  running: number;
  awaiting: number;
  onOpenAwaiting: (() => void) | undefined;
}) {
  const { t } = useTranslation('machines');
  return (
    <div aria-live="polite" className="flex min-h-9 flex-wrap items-center gap-x-1 px-2 text-sm text-muted-foreground">
      {running > 0 && <span>{t('summary.running', { count: running })}</span>}
      {running > 0 && awaiting > 0 && (
        <span aria-hidden="true" className="px-0.5">
          ·
        </span>
      )}
      {awaiting > 0 &&
        (onOpenAwaiting === undefined ? (
          <span>{t('summary.awaiting', { count: awaiting })}</span>
        ) : (
          <button
            type="button"
            onClick={onOpenAwaiting}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-1.5 font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
              TONE_TEXT.attention,
            )}
          >
            <ShieldExclamationPoint className="size-4" aria-hidden="true" />
            {t('summary.awaiting', { count: awaiting })}
          </button>
        ))}
    </div>
  );
}
