import { describe, expect, it } from 'vitest';
import type { SessionsViewport } from '../src/common/control-api.js';
import { daemonReady } from '../src/common/daemon-ready.js';
import { decideSessionsView, parseViewport, viewBounds } from '../src/main/sessions-viewport.js';

const SIZE = { width: 1180, height: 760 };
const rect = { x: 232, y: 40, width: 948, height: 720 };
const report = (extra: Partial<SessionsViewport> = {}): SessionsViewport => ({ ...rect, active: true, covered: false, ...extra });

describe('daemonReady', () => {
  const status = (state: string, restricted = false) => ({ state, restricted }) as Parameters<typeof daemonReady>[0];

  it('is true for a daemon that is up and accepts calls from this PC', () => {
    expect(daemonReady(status('running'))).toBe(true);
    expect(daemonReady(status('attached'))).toBe(true);
  });

  it('is false while it starts, is stopped, failed, or refuses this PC (Tailscale-only)', () => {
    for (const state of ['starting', 'stopped', 'error']) expect(daemonReady(status(state)), state).toBe(false);
    expect(daemonReady(status('running', true))).toBe(false);
    expect(daemonReady(status('attached', true))).toBe(false);
  });
});

describe('view bounds from the reported rectangle', () => {
  it('keeps a whole-pixel rectangle that fits', () => {
    expect(viewBounds(rect, SIZE)).toEqual(rect);
  });

  it('rounds the edges, not the sizes, so two neighbours never leave a gap or overlap by a pixel', () => {
    expect(viewBounds({ x: 231.6, y: 40.4, width: 948.5, height: 719.3 }, SIZE)).toEqual({ x: 232, y: 40, width: 948, height: 720 });
    expect(viewBounds({ x: 10.5, y: 10.5, width: 100.4, height: 100.4 }, SIZE)).toEqual({ x: 11, y: 11, width: 100, height: 100 });
  });

  it('clamps to the window content, whatever the page claims', () => {
    expect(viewBounds({ x: -20, y: -5, width: 400, height: 300 }, SIZE)).toEqual({ x: 0, y: 0, width: 380, height: 295 });
    expect(viewBounds({ x: 1000, y: 700, width: 900, height: 900 }, SIZE)).toEqual({ x: 1000, y: 700, width: 180, height: 60 });
  });

  it('has nothing to draw for an empty, inverted or off-window rectangle', () => {
    expect(viewBounds({ ...rect, width: 0 }, SIZE)).toBeNull();
    expect(viewBounds({ ...rect, height: -3 }, SIZE)).toBeNull();
    expect(viewBounds({ x: 2000, y: 40, width: 100, height: 100 }, SIZE)).toBeNull();
    expect(viewBounds({ x: 0, y: 900, width: 100, height: 100 }, SIZE)).toBeNull();
    expect(viewBounds(rect, { width: 0, height: 0 })).toBeNull();
  });

  it('follows a smaller window (resize) and a collapsed sidebar (a wider rectangle)', () => {
    expect(viewBounds(rect, { width: 940, height: 620 })).toEqual({ x: 232, y: 40, width: 708, height: 580 });
    expect(viewBounds({ ...rect, x: 64, width: 1116 }, SIZE)).toEqual({ x: 64, y: 40, width: 1116, height: 720 });
  });
});

describe('when the sessions view is shown', () => {
  it('shows it over the reported rectangle: sessions active, nothing covering, daemon ready', () => {
    expect(decideSessionsView({ viewport: report(), daemonReady: true, contentSize: SIZE })).toEqual({ visible: true, bounds: rect });
  });

  it.each([
    ['another section is on screen', report({ active: false })],
    ['a dialog or toast covers the area', report({ covered: true })],
  ])('hides it when %s, but keeps the last bounds for when it comes back', (_label, viewport) => {
    expect(decideSessionsView({ viewport, daemonReady: true, contentSize: SIZE })).toEqual({ visible: false, bounds: rect });
  });

  it('hides it while the daemon is not ready, even when the page says it is active', () => {
    expect(decideSessionsView({ viewport: report(), daemonReady: false, contentSize: SIZE }).visible).toBe(false);
  });

  it('hides it with no report yet, and with an area that is empty', () => {
    expect(decideSessionsView({ viewport: null, daemonReady: true, contentSize: SIZE })).toEqual({ visible: false, bounds: null });
    expect(decideSessionsView({ viewport: report({ width: 0 }), daemonReady: true, contentSize: SIZE })).toEqual({ visible: false, bounds: null });
  });
});

describe('what the page reports', () => {
  it('accepts a complete report', () => {
    expect(parseViewport(report())).toEqual(report());
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a missing flag', { ...rect, active: true }],
    ['a flag that is not a boolean', { ...report(), covered: 'no' }],
    ['a coordinate that is not a number', { ...report(), x: '232' }],
    ['a coordinate that is not finite', { ...report(), width: Number.POSITIVE_INFINITY }],
    ['a coordinate that is NaN', { ...report(), y: Number.NaN }],
    ['an absurd size', { ...report(), height: 1e9 }],
  ])('refuses %s', (_label, value) => {
    expect(parseViewport(value)).toBeNull();
  });

  it('keeps only the known fields', () => {
    expect(parseViewport({ ...report(), extra: 'ignored' })).toEqual(report());
  });
});
