import type { WorkspaceInfoResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { workingTreeState } from './workingTree.js';

const plain = { worktree: null };
const inWorktree = { worktree: { path: 'C:\\Projects\\nanachi-wt', branch: 'nanachi/feature' } };

const loading = { data: null, error: null };
const failed = { data: null, error: new Error('offline') };
const info = (changedFiles: number | null): { data: WorkspaceInfoResponse; error: null } => ({
  data: { branch: changedFiles === null ? null : 'main', changedFiles, instructions: [] },
  error: null,
});

describe('workingTreeState (the first row of the commit history)', () => {
  it('is loading until the workspace info arrives, so the list is never held back by it', () => {
    expect(workingTreeState(plain, loading, loading)).toEqual({ kind: 'loading' });
  });

  it('is hidden when the workspace info failed', () => {
    expect(workingTreeState(plain, failed, loading)).toEqual({ kind: 'hidden' });
  });

  it('is hidden for a folder that is not a git repository (changedFiles null)', () => {
    expect(workingTreeState(plain, info(null), loading)).toEqual({ kind: 'hidden' });
  });

  it('counts a session that runs in the workspace folder with the info, without reading its diff', () => {
    expect(workingTreeState(plain, info(3), loading)).toEqual({ kind: 'counted', changedFiles: 3 });
    expect(workingTreeState(plain, info(0), loading)).toEqual({ kind: 'counted', changedFiles: 0 });
  });

  it('counts a worktree session with its own diff, because the info counts the workspace folder instead', () => {
    expect(workingTreeState(inWorktree, info(2), { data: 5, error: null })).toEqual({ kind: 'counted', changedFiles: 5 });
  });

  it('waits for the diff of a worktree session', () => {
    expect(workingTreeState(inWorktree, info(2), loading)).toEqual({ kind: 'loading' });
  });

  it('shows a worktree session without a count when its diff failed', () => {
    expect(workingTreeState(inWorktree, info(2), { data: null, error: new Error('busy') })).toEqual({
      kind: 'counted',
      changedFiles: null,
    });
  });
});
