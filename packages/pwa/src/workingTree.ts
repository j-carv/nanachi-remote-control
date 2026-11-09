import type { Session, WorkspaceInfoResponse } from '@nanachi/shared';
import type { AsyncState } from './useAsync.js';

/**
 * What the first row of the commit history shows: loading, hidden (the folder is not a git repository, or its info did
 * not load), or the number of changed files. `changedFiles` is null when that count did not load.
 */
export type WorkingTreeState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'counted'; readonly changedFiles: number | null };

const LOADING: WorkingTreeState = { kind: 'loading' };
const HIDDEN: WorkingTreeState = { kind: 'hidden' };

/**
 * The state of the working-tree row. The workspace info counts the workspace folder, which is the session's own folder
 * unless the session has a worktree: then only the session diff counts the worktree, and `worktreeFiles` is that count.
 * It is only loaded for a worktree session; for the others it is ignored. Pure: the screen loads both and passes them in.
 */
export function workingTreeState(
  session: Pick<Session, 'worktree'>,
  info: Pick<AsyncState<WorkspaceInfoResponse>, 'data' | 'error'>,
  worktreeFiles: Pick<AsyncState<number | null>, 'data' | 'error'>,
): WorkingTreeState {
  if (info.error !== null) return HIDDEN;
  if (info.data === null) return LOADING;
  if (info.data.changedFiles === null) return HIDDEN;
  if (session.worktree === null) return { kind: 'counted', changedFiles: info.data.changedFiles };
  if (worktreeFiles.error !== null) return { kind: 'counted', changedFiles: null };
  if (worktreeFiles.data === null) return LOADING;
  return { kind: 'counted', changedFiles: worktreeFiles.data };
}
