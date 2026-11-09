import { useEffect, useState } from 'react';
import type { SessionSearchResult } from '@nanachi/shared';
import type { ApiClient } from './api.js';
import { MESSAGE_SEARCH_DEBOUNCE_MS, messageSearchQuery } from './sessionSearch.js';

/**
 * `idle`: the query is too short to search. `loading`: asked, not answered yet (or the answer is for an older query).
 * `failed`: the machine could not answer. `ready`: the matches, newest first.
 */
export type MessageSearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed'; error: unknown }
  | { status: 'ready'; results: readonly SessionSearchResult[] };

type Outcome = { ok: true; results: readonly SessionSearchResult[] } | { ok: false; error: unknown };

interface Answer {
  key: string;
  outcome: Outcome;
}

const IDLE: MessageSearchState = { status: 'idle' };
const LOADING: MessageSearchState = { status: 'loading' };

/**
 * The message search for `query` on the machine of `api`, narrowed to `workspaceId` (null: every workspace). It asks
 * `MESSAGE_SEARCH_DEBOUNCE_MS` after the last change, and an answer that comes back for a query that is no longer on
 * screen is dropped.
 */
export function useSessionMessageSearch(
  api: ApiClient,
  query: string,
  workspaceId: string | null,
): MessageSearchState {
  const search = messageSearchQuery(query);
  const key = search === null ? null : `${api.baseUrl}\n${workspaceId ?? ''}\n${search}`;
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (search === null || key === null) return undefined;
    let active = true;
    const request = workspaceId === null ? { q: search } : { q: search, workspaceId };
    const timer = window.setTimeout(() => {
      api.searchSessions(request).then(
        (results) => {
          if (active) setAnswer({ key, outcome: { ok: true, results } });
        },
        (error: unknown) => {
          if (active) setAnswer({ key, outcome: { ok: false, error } });
        },
      );
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, search, key, workspaceId]);

  if (key === null) return IDLE;
  if (answer === null || answer.key !== key) return LOADING;
  return answer.outcome.ok
    ? { status: 'ready', results: answer.outcome.results }
    : { status: 'failed', error: answer.outcome.error };
}
