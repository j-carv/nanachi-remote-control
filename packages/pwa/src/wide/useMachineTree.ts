import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import type { Connection, ConnectionStatus } from '../connection.js';
import { useAsync } from '../useAsync.js';
import { buildTree, shouldReloadTree, type WorkspaceNode } from './sessionTree.js';

interface Loaded {
  workspaces: Workspace[];
  sessions: Record<string, Session[]>;
}

export interface MachineTree {
  /** Null until the first load answers. */
  nodes: WorkspaceNode[] | null;
  error: unknown;
  reload(): void;
}

/** What the tree loads from the machine. */
type TreeSource = Pick<ApiClient, 'listWorkspaces' | 'listSessions'>;

/**
 * The workspaces and their sessions. A workspace whose sessions cannot be listed still appears, with no sessions and so no
 * counts, so one failing workspace does not hide the others. A machine that cannot list its workspaces fails the load.
 */
export async function loadAll(api: TreeSource): Promise<Loaded> {
  const workspaces = await api.listWorkspaces();
  const lists = await Promise.all(
    workspaces.map((workspace) => api.listSessions(workspace.id).catch((): Session[] => [])),
  );
  const sessions: Record<string, Session[]> = {};
  workspaces.forEach((workspace, index) => {
    sessions[workspace.id] = lists[index] ?? [];
  });
  return { workspaces, sessions };
}

/**
 * The workspaces of one machine with their sessions, for the list pane. The first load asks the machine; after it the
 * `session` and `session_removed` messages of the machine's connection keep the rows current (status, title, new
 * sessions), the way the sessions screen does. `reload` asks again (a workspace was added or removed), and it happens by
 * itself when the machine comes back online (`status`, see `shouldReloadTree`).
 */
export function useMachineTree(
  api: ApiClient,
  connection: Connection | undefined,
  status: ConnectionStatus | undefined,
): MachineTree {
  const loaded = useAsync(() => loadAll(api), [api]);
  // A stable `reload`: the list pane subscribes to it in effects.
  const reloadRef = useRef(loaded.reload);
  reloadRef.current = loaded.reload;
  const reload = useCallback(() => reloadRef.current(), []);
  // Ask again when the machine answers after the list was loaded without it, or after it went away and came back.
  const previousStatus = useRef(status);
  const failed = loaded.error !== null;
  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = status;
    if (shouldReloadTree(before, status, failed)) reloadRef.current();
  }, [status]);
  const [live, setLive] = useState<Readonly<Record<string, Session>>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

  useEffect(
    () =>
      connection?.onMessage((message) => {
        if (message.type === 'session') {
          const { session } = message;
          setLive((previous) => ({ ...previous, [session.id]: session }));
        }
        if (message.type === 'session_removed') {
          const { sessionId } = message;
          setRemoved((previous) => new Set(previous).add(sessionId));
        }
      }),
    [connection],
  );

  // A reload that fails leaves `data` null (useAsync): the rows already on screen stay, under the error, until one loads.
  const [lastLoaded, setLastLoaded] = useState<Loaded | null>(null);
  const data = loaded.data;
  if (data !== null && data !== lastLoaded) setLastLoaded(data);
  const shown = data ?? lastLoaded;
  const nodes = useMemo(
    () => (shown === null ? null : buildTree(shown.workspaces, shown.sessions, live, removed)),
    [shown, live, removed],
  );

  return { nodes, error: loaded.error, reload };
}
