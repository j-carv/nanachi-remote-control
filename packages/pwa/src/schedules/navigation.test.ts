import { describe, expect, it } from 'vitest';
import type { Session, Workspace } from '@nanachi/shared';
import { planRestore, readLastRoute, toPersistedRoute, writeLastRoute } from '../lastRoute.js';
import { activeRoute, initialNav, pushNav, selectNav } from '../navigation.js';
import { detailKey, keepsBackOnWide } from '../wide/layout.js';
import { opensInSidePane } from '../wide/sidePane.js';
import { selectionOf } from '../wide/sessionTree.js';

const workspace: Workspace = { id: 'workspace-1', name: 'Synthetic workspace á', path: 'C:\\Synthetic workspace á', muted: false, createdAt: 1 };
const execution: Session = { id: 'automation-session', workspaceId: workspace.id, automationRunId: 'run-1', agent: 'fake-acp', kind: 'acp', accountId: 'default', title: 'Scheduled task', worktree: null, status: 'awaiting_permission', createdAt: 1, updatedAt: 2 };
const schedules = { kind: 'schedules' as const, workspace };

describe('workspace schedule navigation', () => {
  it('opens schedules from mobile workspace navigation and marks only the workspace on wide screens', () => {
    const mobile = pushNav(initialNav({ kind: 'sessions', workspace }), schedules);
    expect(activeRoute(mobile.nav)).toEqual(schedules);
    expect(selectionOf(schedules)).toEqual({ workspaceId: workspace.id, sessionId: null });
    expect(detailKey(schedules)).toBe(`schedules:${workspace.id}`);
    expect(keepsBackOnWide(schedules)).toBe(false);
    expect(opensInSidePane(schedules, { kind: 'chat', workspace, session: execution })).toBe(false);
    const wide = selectNav(mobile.nav, schedules);
    expect(wide.nav.routes).toHaveLength(2);
    expect(activeRoute(wide.nav)).toEqual(schedules);
  });

  it('stores only machine/workspace IDs and restores the schedules destination without reading ordinary sessions', async () => {
    const saved = toPersistedRoute('machine-1', schedules);
    expect(saved).toEqual({ kind: 'schedules', machineId: 'machine-1', workspaceId: workspace.id });
    if (saved === null) throw new Error('Schedule route was not persisted');
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    expect(writeLastRoute(storage, saved)).toBe(true);
    expect(readLastRoute(storage)).toEqual(saved);
    const stack = await planRestore(saved, { listWorkspaces: async () => [workspace], fetchSession: async () => { throw new Error('Schedules must not read a session'); } });
    expect(stack).toEqual([{ kind: 'home' }, { kind: 'workspaces' }, { kind: 'sessions', workspace }, schedules]);
  });

  it('reopens an explicitly selected automation execution by direct lookup, without making it an ordinary list item', async () => {
    const saved = toPersistedRoute('machine-1', { kind: 'chat', workspace, session: execution });
    if (saved === null) throw new Error('Chat route was not persisted');
    const stack = await planRestore(saved, { listWorkspaces: async () => [workspace], fetchSession: async (id) => {
      expect(id).toBe(execution.id);
      return execution;
    } });
    expect(stack.at(-1)).toEqual({ kind: 'chat', workspace, session: execution });
  });

  it('does not open a session returned for another workspace', async () => {
    const stack = await planRestore({ kind: 'chat', machineId: 'machine-1', workspaceId: workspace.id, sessionId: execution.id }, {
      listWorkspaces: async () => [workspace], fetchSession: async () => ({ ...execution, workspaceId: 'another-workspace' }),
    });
    expect(stack.at(-1)).toEqual({ kind: 'sessions', workspace });
  });
});
