import { describe, expect, it, vi } from 'vitest';
import { FOLLOWING, maxScrollTop, restoreView } from '../../src/control/lib/log-view.js';
import { createLogViewStore } from '../../src/control/state/log-view.js';

/** A viewport 400 px tall over 1000 px of log: the end is 600 px down. */
const LOG = { scrollHeight: 1000, clientHeight: 400 };

describe('maxScrollTop', () => {
  it('is how far the viewport can scroll', () => {
    expect(maxScrollTop(LOG)).toBe(600);
  });

  it('is zero when the content fits without scrolling', () => {
    expect(maxScrollTop({ scrollHeight: 300, clientHeight: 400 })).toBe(0);
  });
});

describe('restoreView', () => {
  it('a viewer that was following is pinned to the end, whatever offset it was left at', () => {
    expect(restoreView({ following: true, scrollTop: 100 }, LOG)).toEqual({ following: true, scrollTop: 600 });
  });

  it('a paused viewer goes back to the offset it was left at and stays paused', () => {
    expect(restoreView({ following: false, scrollTop: 150 }, LOG)).toEqual({ following: false, scrollTop: 150 });
  });

  it('a log that grew while away keeps the same lines in view: the offset is not moved', () => {
    // Lines were appended below the view, so the end moved away and the offset still shows what it showed.
    expect(restoreView({ following: false, scrollTop: 150 }, { scrollHeight: 1400, clientHeight: 400 })).toEqual({
      following: false,
      scrollTop: 150,
    });
  });

  it('a log that shrank while away clamps the offset to its new end, and then follows it', () => {
    expect(restoreView({ following: false, scrollTop: 900 }, LOG)).toEqual({ following: true, scrollTop: 600 });
  });

  it('a paused offset within the follow threshold of the end counts as following', () => {
    expect(restoreView({ following: false, scrollTop: 580 }, LOG)).toEqual({ following: true, scrollTop: 580 });
  });

  it('a paused offset beyond the follow threshold stays paused', () => {
    expect(restoreView({ following: false, scrollTop: 570 }, LOG)).toEqual({ following: false, scrollTop: 570 });
  });

  it('a log that fits the viewport has nothing to scroll, so it follows', () => {
    expect(restoreView({ following: false, scrollTop: 40 }, { scrollHeight: 300, clientHeight: 400 })).toEqual({
      following: true,
      scrollTop: 0,
    });
  });

  it('a negative offset is clamped to the top and stays paused', () => {
    expect(restoreView({ following: false, scrollTop: -5 }, LOG)).toEqual({ following: false, scrollTop: 0 });
  });
});

describe('log view store', () => {
  it('starts every tab at the end, following', () => {
    const store = createLogViewStore();
    expect(store.getState('daemon')).toEqual(FOLLOWING);
    expect(store.getState('tailscale')).toEqual(FOLLOWING);
  });

  it('keeps the state of each tab apart', () => {
    const store = createLogViewStore();
    store.setFollowing('daemon', false);
    store.setScrollTop('daemon', 120);
    expect(store.getState('daemon')).toEqual({ following: false, scrollTop: 120 });
    expect(store.getState('tailscale')).toEqual(FOLLOWING);
  });

  it('tells listeners when following changes, and not when it stays the same', () => {
    const store = createLogViewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setFollowing('daemon', true);
    expect(listener).not.toHaveBeenCalled();
    store.setFollowing('daemon', false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('records the scroll offset without telling listeners, so scrolling does not re-render the section', () => {
    const store = createLogViewStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setScrollTop('daemon', 80);
    expect(store.getState('daemon').scrollTop).toBe(80);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops telling a listener that unsubscribed', () => {
    const store = createLogViewStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    stop();
    store.setFollowing('daemon', false);
    expect(listener).not.toHaveBeenCalled();
  });
});
