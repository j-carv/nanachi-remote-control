import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus, Workspace } from '@nanachi/shared';
import type { Route } from '../navigation.js';
import {
  buildTree,
  mergeSessions,
  selectionOf,
  SESSION_ROW_LIMIT,
  shouldReloadTree,
  summarizeTree,
  visibleSessionRows,
} from './sessionTree.js';

function workspace(id: string): Workspace {
  return { id, name: `ws-${id}`, path: `C:\\Projects\\${id}`, muted: false, createdAt: 1 };
}

function session(id: string, workspaceId: string, updatedAt: number, status: SessionStatus = 'idle'): Session {
  return {
    id,
    workspaceId,
    agent: 'claude',
    kind: 'acp',
    title: `Session ${id}`,
    status,
    accountId: null,
    worktree: null,
    createdAt: 1,
    updatedAt,
  };
}

describe('mergeSessions', () => {
  it('sorts the newest first', () => {
    const merged = mergeSessions([session('a', 'w', 10), session('b', 'w', 30), session('c', 'w', 20)], {}, new Set());
    expect(merged.map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('puts a live update over the loaded one when it is newer, and adds sessions the load did not have', () => {
    const merged = mergeSessions(
      [session('a', 'w', 10, 'idle')],
      { a: session('a', 'w', 50, 'running'), z: session('z', 'w', 40, 'idle') },
      new Set(),
    );
    expect(merged.map((item) => [item.id, item.status])).toEqual([
      ['a', 'running'],
      ['z', 'idle'],
    ]);
  });

  it('keeps the loaded session when it is newer than a stale live one (a reload finished after the message)', () => {
    const merged = mergeSessions([session('a', 'w', 90, 'idle')], { a: session('a', 'w', 50, 'running') }, new Set());
    expect(merged[0]?.status).toBe('idle');
  });

  it('drops the sessions removed from the app, loaded or live', () => {
    const merged = mergeSessions(
      [session('a', 'w', 10), session('b', 'w', 20)],
      { c: session('c', 'w', 30) },
      new Set(['b', 'c']),
    );
    expect(merged.map((item) => item.id)).toEqual(['a']);
  });

  it('does not change its inputs', () => {
    const loaded = [session('a', 'w', 10), session('b', 'w', 20)];
    mergeSessions(loaded, {}, new Set());
    expect(loaded.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('buildTree', () => {
  const workspaces = [workspace('w1'), workspace('w2'), workspace('w3')];

  it('keeps the workspaces in the order the machine gave them, each with its own sessions', () => {
    const tree = buildTree(
      workspaces,
      { w1: [session('a', 'w1', 10)], w2: [session('b', 'w2', 20), session('c', 'w2', 30)] },
      {},
      new Set(),
    );
    expect(tree.map((node) => node.workspace.id)).toEqual(['w1', 'w2', 'w3']);
    expect(tree.map((node) => node.sessions.map((item) => item.id))).toEqual([['a'], ['c', 'b'], []]);
  });

  it('routes a live session to its workspace, even when that workspace had none', () => {
    const tree = buildTree(workspaces, {}, { n: session('n', 'w3', 5) }, new Set());
    expect(tree[2]?.sessions.map((item) => item.id)).toEqual(['n']);
    expect(tree[0]?.sessions).toEqual([]);
  });

  it('ignores a live session of a workspace that is not in the list', () => {
    const tree = buildTree(workspaces, {}, { n: session('n', 'gone', 5) }, new Set());
    expect(tree.flatMap((node) => node.sessions)).toEqual([]);
  });

  it('counts the sessions that need the user and the ones working, not stopped or failed ones', () => {
    const tree = buildTree(
      [workspace('w1')],
      {
        w1: [
          session('a', 'w1', 1, 'awaiting_permission'),
          session('b', 'w1', 2, 'running'),
          session('c', 'w1', 3, 'starting'),
          session('d', 'w1', 4, 'idle'),
          session('e', 'w1', 5, 'stopped'),
          session('f', 'w1', 6, 'error'),
        ],
      },
      {},
      new Set(),
    );
    expect(tree[0]?.counts).toEqual({ running: 2, awaiting: 1, idle: 1 });
  });
});

describe('visibleSessionRows', () => {
  const many = Array.from({ length: 10 }, (_, index) => session(`s${index}`, 'w', 100 - index));

  it('shows everything when the workspace has few sessions', () => {
    const few = many.slice(0, SESSION_ROW_LIMIT);
    expect(visibleSessionRows(few, { expanded: false, pinned: null })).toEqual({ rows: few, hidden: 0 });
  });

  it('cuts a long list to the limit and says how many are left out', () => {
    const { rows, hidden } = visibleSessionRows(many, { expanded: false, pinned: null });
    expect(rows).toHaveLength(SESSION_ROW_LIMIT);
    expect(rows.map((item) => item.id)).toEqual(many.slice(0, SESSION_ROW_LIMIT).map((item) => item.id));
    expect(hidden).toBe(many.length - SESSION_ROW_LIMIT);
  });

  it('keeps the open session visible even when it is past the limit, in its own place', () => {
    const open = many[8];
    expect(open).toBeDefined();
    const { rows, hidden } = visibleSessionRows(many, { expanded: false, pinned: open?.id ?? null });
    expect(rows.map((item) => item.id)).toContain('s8');
    expect(rows.at(-1)?.id).toBe('s8');
    expect(rows).toHaveLength(SESSION_ROW_LIMIT + 1);
    expect(hidden).toBe(many.length - SESSION_ROW_LIMIT - 1);
  });

  it('keeps the sessions that need the user visible past the limit', () => {
    const list = [
      ...many.slice(0, 9),
      session('urgent', 'w', 1, 'awaiting_permission'),
    ];
    const { rows } = visibleSessionRows(list, { expanded: false, pinned: null });
    expect(rows.map((item) => item.id)).toContain('urgent');
  });

  it('shows all of them once expanded', () => {
    expect(visibleSessionRows(many, { expanded: true, pinned: null })).toEqual({ rows: many, hidden: 0 });
  });
});

describe('selectionOf', () => {
  const ws = workspace('w1');
  const open = session('s1', 'w1', 1);

  it('marks the workspace and the session of a conversation or its changes', () => {
    const chat: Route = { kind: 'chat', workspace: ws, session: open };
    const changes: Route = { kind: 'changes', workspace: ws, session: open };
    expect(selectionOf(chat)).toEqual({ workspaceId: 'w1', sessionId: 's1' });
    expect(selectionOf(changes)).toEqual({ workspaceId: 'w1', sessionId: 's1' });
  });

  it('marks only the workspace for its sessions list, its files and its editor', () => {
    expect(selectionOf({ kind: 'sessions', workspace: ws })).toEqual({ workspaceId: 'w1', sessionId: null });
    expect(selectionOf({ kind: 'files', workspace: ws, path: '' })).toEqual({ workspaceId: 'w1', sessionId: null });
    expect(selectionOf({ kind: 'editor', workspace: ws, path: 'a.ts' })).toEqual({ workspaceId: 'w1', sessionId: null });
  });

  it('marks nothing for the app screens', () => {
    for (const route of [{ kind: 'home' }, { kind: 'settings' }, { kind: 'workspaces' }, { kind: 'devices' }, { kind: 'folders' }] as Route[]) {
      expect(selectionOf(route)).toEqual({ workspaceId: null, sessionId: null });
    }
  });
});

describe('summarizeTree', () => {
  it('adds the working and the waiting sessions of every workspace and points to the newest waiting one', () => {
    const tree = buildTree(
      [workspace('w1'), workspace('w2')],
      {
        w1: [session('a', 'w1', 10, 'running'), session('b', 'w1', 20, 'awaiting_permission')],
        w2: [session('c', 'w2', 50, 'awaiting_permission'), session('d', 'w2', 5, 'idle'), session('e', 'w2', 60, 'stopped')],
      },
      {},
      new Set(),
    );
    const summary = summarizeTree(tree);
    expect(summary.running).toBe(1);
    expect(summary.awaiting).toBe(2);
    expect(summary.awaitingTarget?.session.id).toBe('c');
    expect(summary.awaitingTarget?.workspace.id).toBe('w2');
  });

  it('has no target when nothing waits', () => {
    expect(summarizeTree([])).toEqual({ running: 0, awaiting: 0, awaitingTarget: null });
  });
});

describe('shouldReloadTree', () => {
  it('reloads when the machine comes back online after it was offline or refused the token', () => {
    expect(shouldReloadTree('offline', 'online', false)).toBe(true);
    expect(shouldReloadTree('unauthorized', 'online', false)).toBe(true);
  });

  it('reloads when it comes online and the first load had failed (the machine was unreachable at that time)', () => {
    expect(shouldReloadTree('connecting', 'online', true)).toBe(true);
    expect(shouldReloadTree(undefined, 'online', true)).toBe(true);
  });

  it('does not repeat a first load that is fine: the connection settling on a loaded tree changes nothing', () => {
    expect(shouldReloadTree('connecting', 'online', false)).toBe(false);
    expect(shouldReloadTree(undefined, 'online', false)).toBe(false);
  });

  it('does nothing while it stays online, or when the machine goes down', () => {
    expect(shouldReloadTree('online', 'online', true)).toBe(false);
    expect(shouldReloadTree('online', 'offline', true)).toBe(false);
    expect(shouldReloadTree('offline', 'connecting', true)).toBe(false);
    expect(shouldReloadTree('offline', 'unauthorized', true)).toBe(false);
    expect(shouldReloadTree('online', undefined, true)).toBe(false);
  });
});
