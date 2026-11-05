import type { Session, Workspace } from '@nanachi/shared';
import { countSessions, sessionGroup, type SessionCounts } from '../machineOverview.js';
import type { ConnectionStatus } from '../connection.js';
import type { Route } from '../navigation.js';

/** One workspace of the list pane with the sessions it shows. */
export interface WorkspaceNode {
  workspace: Workspace;
  /** Newest first, without the sessions removed from the app. */
  sessions: Session[];
  counts: SessionCounts;
}

/** Rows a workspace shows before "Mostrar mais". */
export const SESSION_ROW_LIMIT = 6;

/**
 * The sessions of one workspace: what the machine listed, with the `session` messages that arrived since on top (when
 * they are not older than the list: a reload can finish after a message), minus the ones removed from the app, newest
 * first. Does not change its inputs.
 */
export function mergeSessions(
  loaded: readonly Session[],
  live: Readonly<Record<string, Session>>,
  removed: ReadonlySet<string>,
): Session[] {
  const byId = new Map(loaded.map((item) => [item.id, item]));
  for (const item of Object.values(live)) {
    const known = byId.get(item.id);
    if (known === undefined || item.updatedAt >= known.updatedAt) byId.set(item.id, item);
  }
  for (const id of removed) byId.delete(id);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
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
 * The rows a workspace shows: the first `SESSION_ROW_LIMIT`, plus (after them) the open session and every session that
 * waits for the user when they are past the limit, so what matters is never folded away. `hidden` is how many are left out.
 */
export function visibleSessionRows(
  sessions: readonly Session[],
  { expanded, pinned }: RowOptions,
): { rows: Session[]; hidden: number } {
  if (expanded || sessions.length <= SESSION_ROW_LIMIT) return { rows: [...sessions], hidden: 0 };
  const rows = sessions.filter(
    (item, index) => index < SESSION_ROW_LIMIT || item.id === pinned || sessionGroup(item.status) === 'awaiting',
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
      return { workspaceId: route.workspace.id, sessionId: route.session.id };
    case 'sessions':
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
