import { describe, expect, it } from 'vitest';
import { arrivedLive, historyOf } from './liveItems.js';
import type { ChatItem } from './reducer.js';

function message(id: string): ChatItem {
  return { id, kind: 'agent_message', text: id };
}

describe('arrivedLive', () => {
  it('nothing is live before the history has been shown', () => {
    expect(arrivedLive(null, 'agent_message-1')).toBe(false);
    expect(arrivedLive(undefined, 'agent_message-1')).toBe(false);
  });

  it('an item that was already in the history does not arrive live', () => {
    const history = historyOf([message('agent_message-1'), message('agent_message-2')]);

    expect(arrivedLive(history, 'agent_message-1')).toBe(false);
    expect(arrivedLive(history, 'agent_message-2')).toBe(false);
  });

  it('an item added after the history was shown is live', () => {
    const history = historyOf([message('agent_message-1')]);

    expect(arrivedLive(history, 'tool-call-9')).toBe(true);
  });

  it('the snapshot does not follow the list it was taken from', () => {
    const items: ChatItem[] = [message('agent_message-1')];
    const history = historyOf(items);
    items.push(message('agent_message-2'));

    expect(arrivedLive(history, 'agent_message-2')).toBe(true);
  });
});
