import type { Session, Workspace } from '@nanachi/shared';
import { compareSessionAttention, countSessions, sessionAttentionRank, sessionGroup, type SessionCounts } from '../machineOverview.js';
import { filterBySearch, searchWords } from '../sessionSearch.js';
import type { ConnectionStatus } from '../connection.js';
import type { Route } from '../navigation.js';

/** One workspace of the list pane with the sessions it shows. */
export interface WorkspaceNode {
  workspace: Workspace;
  /** Newest first, without automation runs or sessions removed from the app. */
  sessions: Session[];
  counts: SessionCounts;
}

/**
 * The nodes that hold a session matching the query, each with only its matching sessions (its counts follow them). A
 * workspace with no matching session is left out. A blank query returns the nodes as they are. `fieldsOf` gives the
 * words a session can be found by (title, agent, branch, workspace name).
 */
export function filterTree(
  nodes: readonly WorkspaceNode[],
  query: string,
  fieldsOf: (session: Session, workspace: Workspace) => readonly string[],
): WorkspaceNode[] {
  if (searchWords(query).length === 0) return [...nodes];
  const found: WorkspaceNode[] = [];
  for (const node of nodes) {
    const sessions = filterBySearch(node.sessions, query, (session) => fieldsOf(session, node.workspace));
    if (sessions.length > 0) found.push({ workspace: node.workspace, sessions, counts: countSessions(sessions) });
  }
  return found;
}

/** Rows a workspace shows before "Mostrar mais". */
export const SESSION_ROW_LIMIT = 6;

/**
 * The sessions of one workspace: what the machine listed, with the `session` messages that arrived since on top (when
 * they are not older than the list: a reload can finish after a message), minus automation runs and sessions removed
 * from the app, newest first. Does not change its inputs.
 */
export function mergeSessions(
  loaded: readonly Session[],
  live: Readonly<Record<string, Session>>,
  removed: ReadonlySet<string>,
): Session[] {
  const byId = new Map(loaded.map((item) => [item.id, item]));
  for (const item of Object.values(live)) {
    const known = byId.get(item.id);
    // Run ownership wins over timestamps: a stale snapshot must not reveal a known automation run.
    if (known?.automationRunId !== undefined) continue;
    if (item.automationRunId !== undefined || known === undefined || item.updatedAt >= known.updatedAt) {
      byId.set(item.id, item);
    }
  }
  for (const id of removed) byId.delete(id);
  return [...byId.values()]
    .filter((item) => item.automationRunId === undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Workspaces in the order the machine gave them (a list that reorders as sessions move is hard to scan), each with its sessions. */
export function buildTree(
  workspaces: readonly Workspace[],
  loaded: Readonly<Record<string, readonly Session[]>>,
  live: Readonly<Record<string, Session>>,
  removed: ReadonlySet<string>,
): WorkspaceNode[] {
  const liveByWorkspace = new Map<string, Record<string, Session>>();
  for (const item of Object.values(live)) {
    const group = liveByWorkspace.get(item.workspaceId) ?? {};
    group[item.id] = item;
    liveByWorkspace.set(item.workspaceId, group);
  }
  return workspaces.map((workspace) => {
    const sessions = mergeSessions(loaded[workspace.id] ?? [], liveByWorkspace.get(workspace.id) ?? {}, removed);
    return { workspace, sessions, counts: countSessions(sessions) };
  });
}

/**
 * Whether the list pane asks the machine again because its connection changed. The `session` messages only keep the rows
 * current while the connection is up, so a machine that comes back online (after being offline or refusing the token) has
 * missed some; and a first load that failed (the machine was unreachable then) is retried once it answers. A connection
 * that just settles from `connecting` over a tree that loaded fine changes nothing.
 */
export function shouldReloadTree(
  previous: ConnectionStatus | undefined,
  next: ConnectionStatus | undefined,
  loadFailed: boolean,
): boolean {
  if (next !== 'online' || previous === 'online') return false;
  return previous === 'offline' || previous === 'unauthorized' || loadFailed;
}

export interface RowOptions {
  /** The user asked for the whole list. */
  expanded: boolean;
  /** The session open in the chat: it never hides behind "Mostrar mais". */
  pinned: string | null;
}

/**
 * Shows sessions needing attention first. The open session and every session needing attention stay visible past the limit.
 */
export function visibleSessionRows(
  sessions: readonly Session[],
  { expanded, pinned }: RowOptions,
): { rows: Session[]; hidden: number } {
  const ordered = [...sessions].sort(compareSessionAttention);
  if (expanded || ordered.length <= SESSION_ROW_LIMIT) return { rows: ordered, hidden: 0 };
  const rows = ordered.filter(
    (item, index) => index < SESSION_ROW_LIMIT || item.id === pinned || sessionAttentionRank(item.status) < 2,
  );
  return { rows, hidden: sessions.length - rows.length };
}

/** What the open screen says about the rows of the list: the workspace it belongs to and the session it shows, if any. */
export interface Selection {
  workspaceId: string | null;
  sessionId: string | null;
}

export function selectionOf(route: Route): Selection {
  switch (route.kind) {
    case 'chat':
    case 'changes':
    case 'commits':
    case 'commit':
      return { workspaceId: route.workspace.id, sessionId: route.session.id };
    case 'sessions':
    case 'schedules':
    case 'files':
    case 'editor':
      return { workspaceId: route.workspace.id, sessionId: null };
    case 'home':
    case 'pair':
    case 'settings':
    case 'workspaces':
    case 'folders':
    case 'devices':
      return { workspaceId: null, sessionId: null };
  }
}

export interface TreeSummary {
  running: number;
  awaiting: number;
  /** The session that has waited for the user the shortest time, to jump to it. */
  awaitingTarget: { workspace: Workspace; session: Session } | null;
}

/** Totals over the whole tree: sessions working, sessions waiting for permission, and the most recent one of those. */
export function summarizeTree(nodes: readonly WorkspaceNode[]): TreeSummary {
  let running = 0;
  let awaiting = 0;
  let target: { workspace: Workspace; session: Session } | null = null;
  for (const node of nodes) {
    running += node.counts.running;
    awaiting += node.counts.awaiting;
    for (const session of node.sessions) {
      if (sessionGroup(session.status) !== 'awaiting') continue;
      if (target === null || session.updatedAt > target.session.updatedAt) target = { workspace: node.workspace, session };
    }
  }
  return { running, awaiting, awaitingTarget: target };
}
