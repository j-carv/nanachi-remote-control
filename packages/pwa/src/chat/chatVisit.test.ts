import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../machines.js';
import {
  chatVisitKey, firstUnreadIndex, forgetChatVisit, insertMessageInDraft, readChatDraft,
  readChatPosition, writeChatDraft, writeChatPosition,
} from './chatVisit.js';

function memory(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

describe('chat visits', () => {
  it('isolates drafts and positions by machine and session', () => {
    const storage = memory();
    const key = chatVisitKey('pc-one', 'session');
    const otherMachine = chatVisitKey('pc-two', 'session');
    const otherSession = chatVisitKey('pc-one', 'different');
    writeChatDraft(storage, key, '  revise isso\n');
    writeChatPosition(storage, key, 20);
    writeChatPosition(storage, key, 17);
    expect(readChatDraft(storage, key)).toBe('  revise isso\n');
    expect(readChatPosition(storage, key)).toBe(20);
    for (const other of [otherMachine, otherSession]) {
      expect(readChatDraft(storage, other)).toBe('');
      expect(readChatPosition(storage, other)).toBeNull();
    }
    forgetChatVisit(storage, key);
    expect(readChatDraft(storage, key)).toBe('');
    expect(readChatPosition(storage, key)).toBeNull();
  });

  it('marks visible messages and notices newer chunks in an existing reply', () => {
    const items = [
      { id: 'user-1', kind: 'user_message', text: 'hello' },
      { id: 'agent_thought-3', kind: 'agent_thought', text: 'thinking' },
      { id: 'agent_message-4', kind: 'agent_message', lastSeq: 8, text: 'hi there' },
      { id: 'error-10', kind: 'error', message: 'failed' },
    ] as const;
    expect(firstUnreadIndex(items, null)).toBe(-1);
    expect(firstUnreadIndex(items, 1)).toBe(2);
    expect(firstUnreadIndex(items, 5)).toBe(2);
    expect(firstUnreadIndex(items, 8)).toBe(3);
    expect(firstUnreadIndex(items, 10)).toBe(-1);
  });

  it('keeps the text the user was writing when quoting or reusing a message', () => {
    expect(insertMessageInDraft('', 'older', false)).toBe('older');
    expect(insertMessageInDraft('draft', 'older', false)).toBe('draft\n\nolder');
    expect(insertMessageInDraft('draft', 'first\n\nlast', true)).toBe('> first\n>\n> last\n\ndraft');
  });
});
