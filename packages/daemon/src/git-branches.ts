import { GIT_DIRTY_LIST_MAX, type GitBranchesRepo, type GitBranchesResponse } from '@nanachi/shared';
import { ApiError } from './api-error.js';
import { currentBranch, hasCommits, isGitRepo, runGit, stderrOf } from './git.js';

/** `for-each-ref` fields: HEAD marker, short name, upstream, commit date (epoch seconds). Separated by TAB. */
const BRANCH_FORMAT = '%(HEAD)%09%(refname:lstrip=2)%09%(upstream:short)%09%(committerdate:unix)';
/** git's message when a branch is already checked out in another worktree (the wording varies between git versions). */
const IN_USE_MESSAGE = /already (checked out|used by worktree)/i;

/** The workspace is not a git repository: branch routes answer 400 `not_a_git_repo`. */
export async function assertGitRepo(root: string): Promise<void> {
  if (!(await isGitRepo(root))) {
    throw new ApiError(400, 'not_a_git_repo', 'folder is not a git repository');
  }
}

/**
 * Changed paths (modified, staged, and untracked; ignored files excluded), from `git status -z`.
 * A rename comes as `R  new\0old\0`: the next field is the old path and is not listed.
 */
async function dirtyPaths(root: string): Promise<string[]> {
  const out = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: root });
  const fields = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    paths.push(field.slice(3));
    if (code.includes('R') || code.includes('C')) i += 1;
  }
  return paths;
}

/** Local branches, most recent commit first. */
async function localBranches(root: string): Promise<GitBranchesRepo['branches']> {
  const out = await runGit(['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads'], {
    cwd: root,
  });
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [head = '', name = '', upstream = '', unix = ''] = line.split('\t');
      const seconds = Number(unix);
      return {
        name,
        current: head === '*',
        upstream: upstream === '' ? null : upstream,
        lastCommitAt: Number.isFinite(seconds) ? seconds * 1000 : 0,
      };
    });
}

/**
 * Branch state of the workspace: the current branch (or detached HEAD), the branch list, and the changed paths.
 * A folder that is not a git repository answers `{ isRepo: false }` (not an error).
 */
export async function readBranches(root: string): Promise<GitBranchesResponse> {
  if (!(await isGitRepo(root))) return { isRepo: false };
  return readRepoBranches(root);
}

/** Branch state of a folder already known to be a repository (checkout checks that first). */
export async function readRepoBranches(root: string): Promise<GitBranchesRepo> {
  const [current, branches, dirty] = await Promise.all([currentBranch(root), localBranches(root), dirtyPaths(root)]);
  const detachedAt =
    current === null && (await hasCommits(root)) ? (await runGit(['rev-parse', '--short', 'HEAD'], { cwd: root })).trim() : null;
  return {
    isRepo: true,
    current,
    detachedAt,
    branches,
    dirty: dirty.slice(0, GIT_DIRTY_LIST_MAX),
  };
}

/**
 * Checks the name with git (`check-ref-format --branch`). git prints the name it accepted; if the output differs from
 * the input (for example an `@{-n}` expansion), the name is refused. Not accepted → 400 `invalid_branch`.
 */
export async function assertBranchName(root: string, branch: string): Promise<void> {
  let printed: string;
  try {
    printed = (await runGit(['check-ref-format', '--branch', branch], { cwd: root })).trim();
  } catch {
    throw new ApiError(400, 'invalid_branch', 'invalid branch name');
  }
  if (printed !== branch) {
    throw new ApiError(400, 'invalid_branch', 'invalid branch name');
  }
}

/**
 * Switches to a branch, or creates and switches with `create`. Refuses with uncommitted changes (409 `dirty_worktree`,
 * with the list in `details`). `create` on an existing branch → 409 `branch_exists`. Without `create`, a local branch
 * that does not exist → 404 `branch_not_found`. A branch checked out in another worktree → 409 `branch_in_use`.
 * `--no-guess`: without `create`, git does not create a tracking branch from a remote on its own.
 */
export async function switchBranch(root: string, branch: string, create: boolean): Promise<void> {
  const dirty = await dirtyPaths(root);
  if (dirty.length > 0) {
    throw new ApiError(409, 'dirty_worktree', 'there are uncommitted changes', {
      dirty: dirty.slice(0, GIT_DIRTY_LIST_MAX),
    });
  }

  const exists = (await localBranches(root)).some((item) => item.name === branch);
  if (create && exists) throw new ApiError(409, 'branch_exists', 'a branch with this name already exists');
  if (!create && !exists) throw new ApiError(404, 'branch_not_found', 'local branch not found');

  try {
    await runGit(create ? ['switch', '-c', branch] : ['switch', '--no-guess', branch], { cwd: root });
  } catch (error) {
    if (IN_USE_MESSAGE.test(stderrOf(error))) {
      throw new ApiError(409, 'branch_in_use', 'the branch is checked out in another worktree');
    }
    throw error;
  }
}
