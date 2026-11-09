import { describe, expect, it } from 'vitest';
import type { ControlError, ControlResult } from '../../src/common/control-api.js';
import type { PairingCode } from '../../src/common/types.js';
import { CLOSED, needsCode, reducePairing, type PairingSession } from '../../src/control/lib/pairing-session.js';
import { createPairingSessionStore } from '../../src/control/state/pairing-session.js';

const FIVE_MINUTES = 300_000;
const down: ControlError = { ok: false, code: 'daemon_unavailable', message: 'O daemon não respondeu.' };

/** Lets the store's pending `await` run to the end: an answer is applied a few microtasks after it is released. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Requests the test answers by hand, so the order of the answers is the test's to decide. */
function gate() {
  const waiting: Array<(result: ControlResult<PairingCode>) => void> = [];
  return {
    request: (): Promise<ControlResult<PairingCode>> => new Promise((resolve) => waiting.push(resolve)),
    count: (): number => waiting.length,
    async answer(index: number, code: string, expiresAt: number): Promise<void> {
      waiting[index]?.({ ok: true, value: { code, expiresAt } });
      await settled();
    },
    async fail(index: number, error: ControlError): Promise<void> {
      waiting[index]?.(error);
      await settled();
    },
  };
}

function clock(start: number) {
  let current = start;
  return {
    now: (): number => current,
    advance(ms: number): void {
      current += ms;
    },
  };
}

describe('needsCode', () => {
  const live: PairingSession = { open: true, pending: false, issued: { code: '482915', expiresAt: 2_000, startedAt: 1_000 }, failed: null };

  it('asks when no code has been issued yet', () => {
    expect(needsCode({ ...live, issued: null }, 1_500)).toBe(true);
  });

  it('asks again once the last code has expired', () => {
    expect(needsCode(live, 2_000)).toBe(true);
    expect(needsCode(live, 9_000)).toBe(true);
  });

  it('does not ask while the code is live', () => {
    expect(needsCode(live, 1_999)).toBe(false);
  });

  it('does not ask while a request is already on its way', () => {
    expect(needsCode({ ...live, issued: null, pending: true }, 1_500)).toBe(false);
  });
});

describe('reducePairing', () => {
  it('opening an open panel changes nothing, so nothing re-renders', () => {
    const open = reducePairing(CLOSED, { type: 'open' });
    expect(reducePairing(open, { type: 'open' })).toBe(open);
  });

  it('closing discards the code and the error, but remembers a request still on its way', () => {
    const pending = reducePairing(reducePairing(CLOSED, { type: 'open' }), { type: 'request' });
    expect(reducePairing(pending, { type: 'close' })).toEqual({ open: false, pending: true, issued: null, failed: null });
  });

  it('drops an answer that arrives while the panel is closed', () => {
    const closed = reducePairing(reducePairing(CLOSED, { type: 'open' }), { type: 'request' });
    const after = reducePairing(reducePairing(closed, { type: 'close' }), { type: 'issued', code: { code: '482915', expiresAt: 9 }, now: 1 });
    expect(after).toEqual({ open: false, pending: false, issued: null, failed: null });
  });
});

describe('pairing session store', () => {
  it('opening the panel asks once, and the answer is shown with its real expiry', async () => {
    const calls = gate();
    const time = clock(1_000);
    const store = createPairingSessionStore(calls.request, time.now);

    store.open();
    expect(store.getState()).toMatchObject({ open: true, pending: true, issued: null });
    expect(calls.count()).toBe(1);

    await calls.answer(0, '482915', 1_000 + FIVE_MINUTES);
    expect(store.getState()).toMatchObject({ open: true, pending: false, issued: { code: '482915', startedAt: 1_000, expiresAt: 301_000 } });
  });

  it('a live code is not replaced by time alone: it stays on screen once expired', async () => {
    const calls = gate();
    const time = clock(1_000);
    const store = createPairingSessionStore(calls.request, time.now);
    store.open();
    await calls.answer(0, '482915', 1_000 + FIVE_MINUTES);

    time.advance(FIVE_MINUTES * 4);
    expect(store.getState().issued?.code).toBe('482915');
    expect(calls.count()).toBe(1);
  });

  it('opening again while a live code is shown asks for nothing', async () => {
    const calls = gate();
    const time = clock(1_000);
    const store = createPairingSessionStore(calls.request, time.now);
    store.open();
    await calls.answer(0, '482915', 1_000 + FIVE_MINUTES);

    store.open();
    expect(calls.count()).toBe(1);
  });

  it('opening after the code expired asks for a new one', async () => {
    const calls = gate();
    const time = clock(1_000);
    const store = createPairingSessionStore(calls.request, time.now);
    store.open();
    await calls.answer(0, '482915', 1_000 + FIVE_MINUTES);

    time.advance(FIVE_MINUTES);
    store.open();
    expect(calls.count()).toBe(2);
    expect(store.getState().pending).toBe(true);
  });

  it('closing forgets the code, so the next open asks again', async () => {
    const calls = gate();
    const time = clock(1_000);
    const store = createPairingSessionStore(calls.request, time.now);
    store.open();
    await calls.answer(0, '482915', 1_000 + FIVE_MINUTES);

    store.close();
    expect(store.getState()).toEqual(CLOSED);
    store.open();
    expect(calls.count()).toBe(2);
  });

  it('a request still on its way is not sent twice when the panel is closed and opened again', async () => {
    const calls = gate();
    const time = clock(1_000);
    const store = createPairingSessionStore(calls.request, time.now);
    store.open();
    store.close();
    store.open();

    expect(calls.count()).toBe(1);
    await calls.answer(0, '482915', 1_000 + FIVE_MINUTES);
    expect(store.getState()).toMatchObject({ open: true, pending: false, issued: { code: '482915' } });
  });

  it('an answer that arrives after the panel closed is dropped', async () => {
    const calls = gate();
    const store = createPairingSessionStore(calls.request, clock(1_000).now);
    store.open();
    store.close();

    await calls.answer(0, '482915', 1_000 + FIVE_MINUTES);
    expect(store.getState()).toEqual(CLOSED);
  });

  it('a failure is kept for the panel to show, and regenerate asks again', async () => {
    const calls = gate();
    const store = createPairingSessionStore(calls.request, clock(1_000).now);
    store.open();
    await calls.fail(0, down);
    expect(store.getState()).toMatchObject({ open: true, pending: false, issued: null, failed: down });

    store.regenerate();
    expect(calls.count()).toBe(2);
    expect(store.getState().failed).toBeNull();
  });

  it('regenerate does nothing while a request is on its way', () => {
    const calls = gate();
    const store = createPairingSessionStore(calls.request, clock(1_000).now);
    store.open();
    store.regenerate();
    expect(calls.count()).toBe(1);
  });

  it('tells its listeners about each change, and only about changes', () => {
    const calls = gate();
    const store = createPairingSessionStore(calls.request, clock(1_000).now);
    let heard = 0;
    const stop = store.subscribe(() => {
      heard += 1;
    });
    store.open();
    store.open();
    expect(heard).toBe(2);
    stop();
    store.close();
    expect(heard).toBe(2);
  });
});
