import { SESSION_SEARCH_MIN_LENGTH, type SessionSearchResult } from '@nanachi/shared';

/** Pause after the last keystroke before the message search asks the machine. The local filter does not wait. */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 250;

/** Lowercase with accents and combining marks removed, so "Sessão" and "sessao" compare equal. */
export function foldSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The words of a query, folded. A blank query has none. */
export function searchWords(query: string): string[] {
  return foldSearchText(query)
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/**
 * Whether every word of the query is part of some field (accent- and case-insensitive). The words may sit in different
 * fields. A blank query matches everything, so an empty search box keeps the whole list.
 */
export function matchesSearch(query: string, fields: readonly string[]): boolean {
  const words = searchWords(query);
  if (words.length === 0) return true;
  const folded = fields.map(foldSearchText);
  return words.every((word) => folded.some((field) => field.includes(word)));
}

/** The items that match the query through the fields `fieldsOf` gives them, in their order. */
export function filterBySearch<T>(items: readonly T[], query: string, fieldsOf: (item: T) => readonly string[]): T[] {
  return items.filter((item) => matchesSearch(query, fieldsOf(item)));
}

/** The query the message search sends: trimmed, when it has the minimum length the daemon accepts; otherwise null. */
export function messageSearchQuery(query: string): string | null {
  const trimmed = query.trim();
  return trimmed.length >= SESSION_SEARCH_MIN_LENGTH ? trimmed : null;
}

/** A message match joined to the item the screen shows for its session (a session row, or a session with its workspace). */
export interface MessageMatch<T> {
  item: T;
  snippet: string;
  matchedAt: number;
}

/**
 * Joins the daemon's results to the sessions the screen knows, keeping the daemon's order. A result for a session the
 * screen does not have (removed from the app, or outside its list) is left out.
 */
export function resolveMessageMatches<T>(
  results: readonly SessionSearchResult[],
  itemOf: (sessionId: string) => T | undefined,
): MessageMatch<T>[] {
  const matches: MessageMatch<T>[] = [];
  for (const result of results) {
    const item = itemOf(result.sessionId);
    if (item !== undefined) matches.push({ item, snippet: result.snippet, matchedAt: result.matchedAt });
  }
  return matches;
}
