import type { Session, Workspace } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api.js';
import { loadAll } from './useMachineTree.js';

type TreeApi = Pick<ApiClient, 'listWorkspaces' | 'listSessions'>;

const NOW = 1_800_000_000_000;

function workspace(id: string): Workspace {
  return { id, name: id, path: `C:\\Projects\\${id}`, muted: false, createdAt: NOW };
}

function session(id: string, workspaceId: string): Session {
  return {
    id,
    workspaceId,
    agent: 'omp',
    kind: 'acp',
    title: id,
    status: 'idle',
    accountId: null,
    worktree: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fakeApi(workspaces: Workspace[], listSessions: TreeApi['listSessions']): TreeApi {
  return { listWorkspaces: () => Promise.resolve(workspaces), listSessions };
}

describe('loadAll', () => {
  const alpha = workspace('alpha');
  const beta = workspace('beta');

  it('loads the sessions of every workspace, keyed by workspace id', async () => {
    const api = fakeApi([alpha, beta], (id) =>
      Promise.resolve(id === 'alpha' ? [session('a1', 'alpha')] : [session('b1', 'beta'), session('b2', 'beta')]),
    );

    const loaded = await loadAll(api);

    expect(loaded.workspaces).toEqual([alpha, beta]);
    expect(loaded.sessions).toEqual({
      alpha: [session('a1', 'alpha')],
      beta: [session('b1', 'beta'), session('b2', 'beta')],
    });
  });

  it('keeps the other workspaces when one of them cannot list its sessions, which then has none', async () => {
    const api = fakeApi([alpha, beta], (id) =>
      id === 'alpha' ? Promise.resolve([session('a1', 'alpha')]) : Promise.reject(new Error('sessions unavailable')),
    );

    const loaded = await loadAll(api);

    expect(loaded.workspaces).toEqual([alpha, beta]);
    expect(loaded.sessions).toEqual({ alpha: [session('a1', 'alpha')], beta: [] });
  });

  it('fails when the workspaces cannot be listed, so a machine that is down still shows its error', async () => {
    const api: TreeApi = {
      listWorkspaces: () => Promise.reject(new Error('machine offline')),
      listSessions: () => Promise.resolve([]),
    };

    await expect(loadAll(api)).rejects.toThrow('machine offline');
  });
});
