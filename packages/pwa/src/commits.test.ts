import type { CommitEntry } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { appendCommitPage } from './commits.js';

function commit(name: string): CommitEntry {
  return {
    hash: name.padEnd(40, '0'),
    shortHash: name,
    subject: `commit ${name}`,
    summary: null,
    author: 'teste',
    date: 1_700_000_000_000,
  };
}

describe('appendCommitPage', () => {
  it('puts the next page after the commits already loaded, in order', () => {
    const loaded = [commit('a1'), commit('a2')];
    const next = [commit('a3'), commit('a4')];
    expect(appendCommitPage(loaded, next).map((item) => item.shortHash)).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('skips a commit the list already has, when HEAD moved between two pages', () => {
    const loaded = [commit('a1'), commit('a2')];
    const next = [commit('a2'), commit('a3')];
    expect(appendCommitPage(loaded, next).map((item) => item.shortHash)).toEqual(['a1', 'a2', 'a3']);
  });

  it('starts from an empty list on the first page, and leaves its inputs alone', () => {
    const loaded: CommitEntry[] = [];
    const page = [commit('a1')];
    const merged = appendCommitPage(loaded, page);
    expect(merged).toEqual(page);
    expect(loaded).toEqual([]);
    expect(merged).not.toBe(page);
  });

  it('returns the loaded list unchanged for an empty page', () => {
    const loaded = [commit('a1')];
    expect(appendCommitPage(loaded, [])).toEqual(loaded);
  });
});
