import type { SessionEvent } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { loadHistory, type HistoryPageFetcher } from './history.js';

function eventsFrom(from: number, count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: from + i,
    sessionId: 's-1',
    ts: 1,
    kind: 'user_message' as const,
    text: `m${from + i}`,
  }));
}

/** Simula GET /events?after=&limit= sobre uma lista fixa de eventos. */
function serverWith(all: SessionEvent[]) {
  const calls: { after: number; limit: number }[] = [];
  const fetchPage: HistoryPageFetcher = async (after, limit) => {
    calls.push({ after, limit });
    return all.filter((event) => event.seq > after).slice(0, limit);
  };
  return { calls, fetchPage };
}

describe('loadHistory', () => {
  it('pagina com after = último seq e para quando a página vem incompleta', async () => {
    const { calls, fetchPage } = serverWith(eventsFrom(1, 1200));
    const events = await loadHistory(fetchPage, 0, 500);

    expect(events).toHaveLength(1200);
    expect(calls).toEqual([
      { after: 0, limit: 500 },
      { after: 500, limit: 500 },
      { after: 1000, limit: 500 },
    ]);
  });

  it('sem eventos novos devolve lista vazia após uma chamada', async () => {
    const { calls, fetchPage } = serverWith([]);
    expect(await loadHistory(fetchPage, 0, 500)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('começa do afterSeq informado', async () => {
    const { calls, fetchPage } = serverWith(eventsFrom(1, 10));
    const events = await loadHistory(fetchPage, 7, 500);
    expect(calls[0]).toEqual({ after: 7, limit: 500 });
    expect(events.map((event) => event.seq)).toEqual([8, 9, 10]);
  });

  it('página cheia que não avança o cursor não vira laço infinito', async () => {
    const stuck: HistoryPageFetcher = async () => eventsFrom(1, 2);
    const events = await loadHistory(stuck, 0, 2);
    expect(events).toHaveLength(2);
  });

  it('erro da busca propaga para quem chamou', async () => {
    const failing: HistoryPageFetcher = () => Promise.reject(new Error('rede'));
    await expect(loadHistory(failing, 0, 500)).rejects.toThrow('rede');
  });
});
