import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { setLanguage } from '../i18n/index.js';
import {
  branchTitle,
  dirtyFilesOf,
  dirtyPreview,
  filterBranches,
  sortBranches,
  type BranchItem,
} from './branches.js';

const BRANCHES: BranchItem[] = [
  { name: 'main', current: false, upstream: 'origin/main', lastCommitAt: 2_000 },
  { name: 'feat/login', current: true, upstream: null, lastCommitAt: 3_000 },
  { name: 'fix/crash', current: false, upstream: 'origin/fix/crash', lastCommitAt: 1_000 },
  { name: 'docs', current: false, upstream: null, lastCommitAt: 2_000 },
];

describe('sortBranches', () => {
  it('ordena pelo último commit, mais recente primeiro', () => {
    expect(sortBranches(BRANCHES).map((branch) => branch.name)).toEqual([
      'feat/login',
      'docs',
      'main',
      'fix/crash',
    ]);
  });

  it('empate de data cai no nome, para a ordem não oscilar', () => {
    expect(sortBranches(BRANCHES)[1]?.name).toBe('docs');
  });

  it('não altera a lista original', () => {
    const copy = [...BRANCHES];
    sortBranches(BRANCHES);
    expect(BRANCHES).toEqual(copy);
  });
});

describe('filterBranches', () => {
  it('busca sem diferenciar maiúsculas e ignora espaços das bordas', () => {
    expect(filterBranches(BRANCHES, '  LOGIN ').map((branch) => branch.name)).toEqual(['feat/login']);
  });

  it('busca vazia devolve tudo', () => {
    expect(filterBranches(BRANCHES, '   ')).toHaveLength(4);
  });
});

describe('branchTitle', () => {
  it('mostra o nome da branch atual', () => {
    expect(branchTitle({ current: 'main', detachedAt: null })).toBe('main');
  });

  it('HEAD destacado tem rótulo próprio', () => {
    expect(branchTitle({ current: null, detachedAt: 'a1b2c3d' })).toBe('HEAD destacado');
  });
});

describe('dirtyPreview', () => {
  it('lista até o limite e conta o resto', () => {
    const dirty = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(dirtyPreview(dirty, 5)).toEqual({ shown: ['a', 'b', 'c', 'd', 'e'], hidden: 2 });
  });

  it('sem sobra, não tem contagem extra', () => {
    expect(dirtyPreview(['a'], 5)).toEqual({ shown: ['a'], hidden: 0 });
  });
});

describe('dirtyFilesOf', () => {
  it('pega a lista de arquivos sujos do erro dirty_worktree', () => {
    const error = new ApiError('unexpected', 409, null, 'dirty_worktree', { dirty: ['a.ts', 'b.ts'] });
    expect(dirtyFilesOf(error)).toEqual(['a.ts', 'b.ts']);
  });

  it('outro erro, ou lista malformada, não tem arquivos', () => {
    expect(dirtyFilesOf(new ApiError('unexpected', 409, null, 'sessions_running'))).toEqual([]);
    expect(dirtyFilesOf(new ApiError('unexpected', 409, null, 'dirty_worktree', { dirty: 3 }))).toEqual([]);
    expect(dirtyFilesOf(new Error('x'))).toEqual([]);
  });
});

describe('branchTitle in English', () => {
  it('names a detached HEAD in English and keeps a branch name as it is', () => {
    setLanguage('en');
    expect(branchTitle({ current: null, detachedAt: 'a1b2c3d' })).toBe('Detached HEAD');
    expect(branchTitle({ current: 'feature/ui', detachedAt: null })).toBe('feature/ui');
  });
});
