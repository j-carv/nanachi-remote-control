import { describe, expect, it } from 'vitest';
import type { SessionSearchResult } from '@nanachi/shared';
import {
  filterBySearch,
  foldSearchText,
  matchesSearch,
  messageSearchQuery,
  resolveMessageMatches,
  searchWords,
} from './sessionSearch.js';

describe('foldSearchText', () => {
  it('removes accents and lowercases, so "Sessão" and "sessao" compare equal', () => {
    expect(foldSearchText('Sessão')).toBe('sessao');
    expect(foldSearchText('CAFÉ com Açúcar')).toBe('cafe com acucar');
  });

  it('treats the decomposed form (NFD) the same as the composed one', () => {
    expect(foldSearchText('sessão')).toBe('sessao');
    expect(foldSearchText('sessão')).toBe(foldSearchText('sessão'));
  });
});

describe('searchWords', () => {
  it('splits on spaces, trimming and folding each word', () => {
    expect(searchWords('  Sessão   Café ')).toEqual(['sessao', 'cafe']);
    expect(searchWords('   ')).toEqual([]);
  });
});

describe('matchesSearch', () => {
  it('a blank query (or only spaces) matches everything, even a session with no fields', () => {
    expect(matchesSearch('', ['Refatorar'])).toBe(true);
    expect(matchesSearch('   ', [])).toBe(true);
  });

  it('finds a fragment of a word in any field, ignoring accents and case', () => {
    const fields = ['Refatorar o parser', 'omp', 'main', 'app'];
    expect(matchesSearch('pars', fields)).toBe(true);
    expect(matchesSearch('SESSAO', ['Nova Sessão de café'])).toBe(true);
    expect(matchesSearch('cafe', ['Nova Sessão de café'])).toBe(true);
    expect(matchesSearch('banana', fields)).toBe(false);
  });

  it('requires every word to be part of some field (the words may sit in different fields)', () => {
    const fields = ['Refatorar o parser', 'feature/login'];
    expect(matchesSearch('parser login', fields)).toBe(true);
    expect(matchesSearch('parser banana', fields)).toBe(false);
  });
});

describe('filterBySearch', () => {
  it('keeps the order and only the items whose fields match', () => {
    const sessions = [
      { id: 'a', title: 'Refatorar o parser', branch: 'main' },
      { id: 'b', title: 'Notas do café', branch: 'docs' },
      { id: 'c', title: 'Parser novo', branch: 'feature/parser' },
    ];
    const found = filterBySearch(sessions, 'parser', (session) => [session.title, session.branch]);
    expect(found.map((session) => session.id)).toEqual(['a', 'c']);
    expect(filterBySearch(sessions, '', (session) => [session.title])).toEqual(sessions);
  });
});

describe('messageSearchQuery', () => {
  it('returns the trimmed query when it has at least 2 characters, otherwise null', () => {
    expect(messageSearchQuery('  sessão  ')).toBe('sessão');
    expect(messageSearchQuery('ab')).toBe('ab');
    expect(messageSearchQuery('a')).toBeNull();
    expect(messageSearchQuery(' a ')).toBeNull();
    expect(messageSearchQuery('   ')).toBeNull();
  });
});

describe('resolveMessageMatches', () => {
  const result = (sessionId: string, matchedAt: number): SessionSearchResult => ({
    sessionId,
    workspaceId: 'w-1',
    title: `title ${sessionId}`,
    snippet: `snippet of ${sessionId}`,
    matchedAt,
  });

  it('joins each result to the session the screen knows, keeping the daemon order', () => {
    const known = new Map([
      ['s-1', { name: 'one' }],
      ['s-2', { name: 'two' }],
    ]);
    const matches = resolveMessageMatches([result('s-2', 200), result('s-1', 100)], (id) => known.get(id));
    expect(matches).toEqual([
      { item: { name: 'two' }, snippet: 'snippet of s-2', matchedAt: 200 },
      { item: { name: 'one' }, snippet: 'snippet of s-1', matchedAt: 100 },
    ]);
  });

  it('leaves out a result for a session the screen does not have (removed from the app, or outside its list)', () => {
    const matches = resolveMessageMatches([result('s-x', 300)], () => undefined);
    expect(matches).toEqual([]);
  });
});
