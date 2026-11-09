import type { ChatItem } from './reducer.js';

/** Learning rows never contribute to unread activity or the jump-to-end counter. */
export function conversationItemCount(items: readonly ChatItem[]): number {
  return items.reduce((count, item) => count + (item.kind === 'learning' ? 0 : 1), 0);
}

/** Compare conversation objects, skipping inserted or updated learning rows anywhere in history. */
export function isLearningOnlyChange(previous: readonly ChatItem[], next: readonly ChatItem[]): boolean {
  if (previous === next) return false;
  if (previous.length === next.length && previous.every((item, index) => item === next[index])) return false;
  let before = 0;
  let after = 0;
  while (before < previous.length || after < next.length) {
    while (previous[before]?.kind === 'learning') before += 1;
    while (next[after]?.kind === 'learning') after += 1;
    if (before >= previous.length || after >= next.length) return before >= previous.length && after >= next.length;
    if (previous[before] !== next[after]) return false;
    before += 1; after += 1;
  }
  return true;
}
