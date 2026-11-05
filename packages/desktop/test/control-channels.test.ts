import { describe, expect, it } from 'vitest';
import {
  ALLOWED_CONTROL_EVENT_CHANNELS,
  ALLOWED_CONTROL_INVOKE_CHANNELS,
  ALLOWED_CONTROL_SYNC_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
  ALLOWED_INVOKE_CHANNELS,
  ALLOWED_SYNC_CHANNELS,
  CONTROL_EVENT_CHANNELS,
  CONTROL_INVOKE_CHANNELS,
  CONTROL_SYNC_CHANNELS,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SYNC_CHANNELS,
} from '../src/common/channels.js';

const controlAll = [
  ...Object.values(CONTROL_INVOKE_CHANNELS),
  ...Object.values(CONTROL_EVENT_CHANNELS),
  ...Object.values(CONTROL_SYNC_CHANNELS),
];
const bridgeAll = [...Object.values(INVOKE_CHANNELS), ...Object.values(EVENT_CHANNELS), ...Object.values(SYNC_CHANNELS)];

describe('control channel allowlists', () => {
  it('are fixed, prefixed with control: and free of duplicates', () => {
    expect(controlAll.every((channel) => channel.startsWith('control:'))).toBe(true);
    expect(new Set(controlAll).size).toBe(controlAll.length);
    expect(ALLOWED_CONTROL_INVOKE_CHANNELS.size).toBe(Object.keys(CONTROL_INVOKE_CHANNELS).length);
    expect(ALLOWED_CONTROL_EVENT_CHANNELS.size).toBe(Object.keys(CONTROL_EVENT_CHANNELS).length);
    expect(ALLOWED_CONTROL_SYNC_CHANNELS.size).toBe(Object.keys(CONTROL_SYNC_CHANNELS).length);
  });

  it('never share a channel with the PWA bridge, in either direction', () => {
    for (const channel of controlAll) {
      expect(bridgeAll, channel).not.toContain(channel);
      expect(ALLOWED_INVOKE_CHANNELS.has(channel), channel).toBe(false);
      expect(ALLOWED_EVENT_CHANNELS.has(channel), channel).toBe(false);
      expect(ALLOWED_SYNC_CHANNELS.has(channel), channel).toBe(false);
    }
    for (const channel of bridgeAll) {
      expect(controlAll, channel).not.toContain(channel);
      expect(ALLOWED_CONTROL_INVOKE_CHANNELS.has(channel), channel).toBe(false);
      expect(ALLOWED_CONTROL_EVENT_CHANNELS.has(channel), channel).toBe(false);
      expect(ALLOWED_CONTROL_SYNC_CHANNELS.has(channel), channel).toBe(false);
    }
  });

  it('keep invoke, event and sync channels apart from each other', () => {
    for (const channel of ALLOWED_CONTROL_INVOKE_CHANNELS) {
      expect(ALLOWED_CONTROL_EVENT_CHANNELS.has(channel)).toBe(false);
      expect(ALLOWED_CONTROL_SYNC_CHANNELS.has(channel)).toBe(false);
    }
    for (const channel of ALLOWED_CONTROL_EVENT_CHANNELS) {
      expect(ALLOWED_CONTROL_SYNC_CHANNELS.has(channel)).toBe(false);
    }
  });
});
