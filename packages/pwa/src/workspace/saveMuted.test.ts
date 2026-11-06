import type { UpdateWorkspaceRequest, Workspace } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../api.js';
import { saveMuted } from './saveMuted.js';

type MuteApi = Pick<ApiClient, 'updateWorkspace'>;

const workspace: Workspace = { id: 'w1', name: 'nanachi', path: 'C:\\Projects\\nanachi', muted: false, createdAt: 1 };

describe('saveMuted', () => {
  it('keeps the state the machine saved, with no error', async () => {
    const sent: UpdateWorkspaceRequest[] = [];
    const api: MuteApi = {
      updateWorkspace: (id, input) => {
        sent.push(input);
        return Promise.resolve({ ...workspace, id, muted: input.muted });
      },
    };

    await expect(saveMuted(api, 'w1', true)).resolves.toEqual({ muted: true, error: null });
    expect(sent).toEqual([{ muted: true }]);
  });

  it('shows the state the machine kept when it differs from the one asked', async () => {
    const api: MuteApi = { updateWorkspace: () => Promise.resolve({ ...workspace, muted: false }) };

    await expect(saveMuted(api, 'w1', true)).resolves.toEqual({ muted: false, error: null });
  });

  it('reverts to the state before the pick when the save fails, and keeps the error', async () => {
    const failure = new Error('machine offline');
    const api: MuteApi = { updateWorkspace: () => Promise.reject(failure) };

    await expect(saveMuted(api, 'w1', true)).resolves.toEqual({ muted: false, error: failure });
    await expect(saveMuted(api, 'w1', false)).resolves.toEqual({ muted: true, error: failure });
  });
});
