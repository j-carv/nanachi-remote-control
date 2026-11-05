import { describe, expect, it } from 'vitest';
import type { DaemonStatus } from '../../src/common/types.js';
import { createLiveValue } from '../../src/control/state/live.js';

const status = (state: DaemonStatus['state']): DaemonStatus => ({
  state,
  port: 7780,
  mode: 'spawned',
  pid: 1,
  version: '0.1.0',
  machineName: 'PC',
  restricted: false,
  message: null,
  logTail: [],
});

/**
 * The control center keeps the daemon and Tailscale status live from events, and also polls the overview every 5 s. A
 * poll answers what was true when main read it; if an event arrived while the call was in flight, the event is newer.
 */
describe('createLiveValue', () => {
  it('has nothing until it is seeded', () => {
    expect(createLiveValue<DaemonStatus>().value()).toBeNull();
  });

  it('takes the first answer of a poll as the seed', () => {
    const live = createLiveValue<DaemonStatus>();
    expect(live.offer(live.begin(), status('running'))).toBe(true);
    expect(live.value()?.state).toBe('running');
  });

  it('a poll that comes back with no event in between replaces the value (a missed event is corrected)', () => {
    const live = createLiveValue<DaemonStatus>();
    live.event(status('running'));
    const token = live.begin();
    expect(live.offer(token, status('stopped'))).toBe(true);
    expect(live.value()?.state).toBe('stopped');
  });

  it('a poll that started before an event does not overwrite it', () => {
    const live = createLiveValue<DaemonStatus>();
    live.event(status('starting'));
    const token = live.begin();
    // The restart finishes while the poll is in flight.
    live.event(status('running'));
    expect(live.offer(token, status('starting'))).toBe(false);
    expect(live.value()?.state).toBe('running');
  });

  it('a poll that started after the event is newer than it', () => {
    const live = createLiveValue<DaemonStatus>();
    live.event(status('starting'));
    const token = live.begin();
    expect(live.offer(token, status('running'))).toBe(true);
    expect(live.value()?.state).toBe('running');
  });

  it('two polls in flight: only an answer that no event overtook lands', () => {
    const live = createLiveValue<DaemonStatus>();
    live.event(status('running'));
    const early = live.begin();
    live.event(status('stopped'));
    const late = live.begin();
    expect(live.offer(early, status('running'))).toBe(false);
    expect(live.offer(late, status('stopped'))).toBe(true);
  });

  it('a slow poll that answers after a newer one does not put its older answer over the newer', () => {
    const live = createLiveValue<DaemonStatus>();
    live.event(status('running'));
    const slow = live.begin();
    const fast = live.begin();
    expect(live.offer(fast, status('stopped'))).toBe(true);
    expect(live.offer(slow, status('running'))).toBe(false);
    expect(live.value()?.state).toBe('stopped');
  });

  it('the first poll answer seeds the value even when a newer poll has started meanwhile', () => {
    const live = createLiveValue<DaemonStatus>();
    const first = live.begin();
    live.begin();
    expect(live.offer(first, status('starting'))).toBe(true);
    expect(live.value()?.state).toBe('starting');
  });
});
