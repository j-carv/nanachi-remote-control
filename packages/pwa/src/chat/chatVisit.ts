import type { StorageLike } from '../machines.js';
import type { ChatItem } from './reducer.js';

export function chatVisitKey(machineId: string, sessionId: string): string {
  return JSON.stringify([machineId, sessionId]);
}

function read(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: StorageLike, key: string, value: string): void {
  try {
    if (value === '') storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // The current chat remains usable if device storage is blocked or full.
  }
}

export function readChatDraft(storage: StorageLike, key: string): string {
  return read(storage, `nanachi.chatDraft.${key}`) ?? '';
}

export function writeChatDraft(storage: StorageLike, key: string, text: string): void {
  write(storage, `nanachi.chatDraft.${key}`, text);
}

export function forgetChatVisit(storage: StorageLike, key: string): void {
  writeChatDraft(storage, key, '');
  write(storage, `nanachi.chatRead.${key}`, '');
}

export function insertMessageInDraft(draft: string, message: string, quote: boolean): string {
  if (!quote) return draft.trim() === '' ? message : `${draft}\n\n${message}`;
  const quoted = message.split(/\r?\n/).map((line) => line === '' ? '>' : `> ${line}`).join('\n');
  return `${quoted}\n\n${draft}`;
}

export function readChatPosition(storage: StorageLike, key: string): number | null {
  const raw = read(storage, `nanachi.chatRead.${key}`);
  if (raw === null) return null;
  const seq = Number(raw);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

export function writeChatPosition(storage: StorageLike, key: string, seq: number): void {
  const previous = readChatPosition(storage, key);
  if (previous === null || seq > previous) write(storage, `nanachi.chatRead.${key}`, String(seq));
}

/** The reducer uses the originating event sequence in these visible item IDs. */
export function readableSequence(item: ChatItem): number | undefined {
  switch (item.kind) {
    case 'agent_message':
      if (item.lastSeq !== undefined) return item.lastSeq;
      break;
    case 'user_message':
    case 'file':
    case 'error':
      break;
    default:
      return undefined;
  }
  const seq = Number(item.id.slice(item.id.lastIndexOf('-') + 1));
  return Number.isSafeInteger(seq) && seq > 0 ? seq : undefined;
}

export function firstUnreadIndex(items: readonly ChatItem[], after: number | null): number {
  return after === null ? -1 : items.findIndex((item) => (readableSequence(item) ?? 0) > after);
}

/** Find the last row whose bottom is on screen. Binary search avoids scanning older rendered history on scroll. */
export function visibleReadSequence(feed: HTMLElement, viewport: DOMRect): number {
  const rows = feed.children;
  let high = rows.length;
  const end = rows[high - 1];
  let low = end !== undefined && end.getBoundingClientRect().bottom <= viewport.bottom + 1 ? high : 0;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle];
    if (row !== undefined && row.getBoundingClientRect().bottom <= viewport.bottom + 1) low = middle + 1;
    else high = middle;
  }
  for (let index = low - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined || row.getBoundingClientRect().bottom <= viewport.top) break;
    const seq = row.getAttribute('data-readable-seq');
    if (seq !== null) return Number(seq);
  }
  return 0;
}
