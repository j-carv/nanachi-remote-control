import type { SessionEvent } from '@nanachi/shared';

export const HISTORY_PAGE_SIZE = 500;

/** Busca uma página de eventos com seq > after (ex.: `ApiClient.fetchEvents`). */
export type HistoryPageFetcher = (after: number, limit: number) => Promise<SessionEvent[]>;

/**
 * Carrega todo o histórico depois de `afterSeq`, em páginas, até uma página vir incompleta.
 * Página que não traz nenhum seq novo também encerra o laço.
 */
export async function loadHistory(
  fetchPage: HistoryPageFetcher,
  afterSeq: number,
  pageSize: number = HISTORY_PAGE_SIZE,
): Promise<SessionEvent[]> {
  const all: SessionEvent[] = [];
  let cursor = afterSeq;

  for (;;) {
    const page = await fetchPage(cursor, pageSize);
    const fresh = page.filter((event) => event.seq > cursor);
    all.push(...fresh);
    if (fresh.length === 0 || page.length < pageSize) break;
    cursor = fresh.reduce((max, event) => Math.max(max, event.seq), cursor);
  }

  return all;
}
