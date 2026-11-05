import type { ChatItem } from './reducer.js';

/** Ids of the items that were in the conversation when its history was first shown. */
export type HistoryIds = ReadonlySet<string>;

/**
 * Snapshot of the items present when the history loaded. The reducer only appends items and never removes or moves
 * them (see reducer.ts), so an id missing from the snapshot is an item that arrived live.
 */
export function historyOf(items: readonly ChatItem[]): HistoryIds {
  return new Set(items.map((item) => item.id));
}

/**
 * True when the item arrived after the history was shown. Only those enter with motion: opening or reconnecting a
 * conversation must not replay its history. Nothing is live before the snapshot exists.
 */
export function arrivedLive(history: HistoryIds | null | undefined, id: string): boolean {
  return history !== null && history !== undefined && !history.has(id);
}
