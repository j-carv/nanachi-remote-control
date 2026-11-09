import type { CommitEntry } from '@nanachi/shared';

/** Commits per page of the history screen. The daemon's default and its largest page are 30 and 100. */
export const COMMITS_PAGE_SIZE = 30;

/**
 * The commits loaded so far, then the next page. HEAD can move between two pages (a commit made on the PC shifts every
 * row down), so a commit the list already shows is not added a second time. Does not change its inputs.
 */
export function appendCommitPage(loaded: readonly CommitEntry[], page: readonly CommitEntry[]): CommitEntry[] {
  const shown = new Set(loaded.map((commit) => commit.hash));
  return [...loaded, ...page.filter((commit) => !shown.has(commit.hash))];
}
