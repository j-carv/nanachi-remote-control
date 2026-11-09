import { describe, expect, it, vi } from 'vitest';
import { UNINSTALL_GUARD_MS, uninstallGuardRemaining } from '../../src/common/uninstall-guard.js';
import { createUninstallGuardStore } from '../../src/control/lib/uninstall-guard.js';

interface FakeTimer {
  readonly due: number;
  readonly run: () => void;
  cancelled: boolean;
}

/**
 * A clock and timers the test moves by hand. `advance` runs the timers that fall due on the way, each at its own time;
 * `set` moves the clock without running anything (a timer that wakes late or early); `runPending` runs every pending timer
 * where the clock is now.
 */
function fakeTime(start: number) {
  let now = start;
  const timers: FakeTimer[] = [];
  const runDue = (target: number): void => {
    for (;;) {
      const next = timers
        .filter((timer) => !timer.cancelled && timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (next === undefined) return;
      now = next.due;
      next.cancelled = true;
      next.run();
    }
  };
  return {
    clock: (): number => now,
    schedule(callback: () => void, ms: number): () => void {
      const timer: FakeTimer = { due: now + ms, run: callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    pending: (): number => timers.filter((timer) => !timer.cancelled).length,
    advance(ms: number): void {
      const target = now + ms;
      runDue(target);
      now = target;
    },
    set(time: number): void {
      now = time;
    },
    runPending(): void {
      for (const timer of timers.filter((candidate) => !candidate.cancelled)) {
        timer.cancelled = true;
        timer.run();
      }
    },
  };
}

function storeAt(start: number) {
  const time = fakeTime(start);
  const store = createUninstallGuardStore({ clock: time.clock, schedule: time.schedule });
  return { time, store };
}

describe('uninstallGuardRemaining', () => {
  it('keeps the eight-second window of the button', () => {
    expect(UNINSTALL_GUARD_MS).toBe(8_000);
  });

  it('is zero when no press holds the guard', () => {
    expect(uninstallGuardRemaining(null, 1_000)).toBe(0);
  });

  it('counts the window down from the press, and is over when it ends', () => {
    expect(uninstallGuardRemaining(1_000, 1_000)).toBe(UNINSTALL_GUARD_MS);
    expect(uninstallGuardRemaining(1_000, 4_000)).toBe(UNINSTALL_GUARD_MS - 3_000);
    expect(uninstallGuardRemaining(1_000, 1_000 + UNINSTALL_GUARD_MS - 1)).toBe(1);
    expect(uninstallGuardRemaining(1_000, 1_000 + UNINSTALL_GUARD_MS)).toBe(0);
  });

  it('never holds the guard for a clock that went backwards', () => {
    expect(uninstallGuardRemaining(5_000, 1_000)).toBe(0);
  });
});

describe('uninstall guard store', () => {
  it('a press turns the guard on and records when it was made', () => {
    const { time, store } = storeAt(1_000);
    expect(store.getState()).toBeNull();
    expect(store.press()).toBe(true);
    expect(store.getState()).toBe(1_000);
    expect(time.pending()).toBe(1);
  });

  it('a section that remounts within the window still finds the guard, with the time that is really left', () => {
    const { time, store } = storeAt(0);
    store.press();
    time.advance(5_000);
    // A remount reads the same store: nothing restarts the window, so 3 s are left, not 8 s.
    expect(uninstallGuardRemaining(store.getState(), time.clock())).toBe(UNINSTALL_GUARD_MS - 5_000);
    expect(time.pending()).toBe(1);
  });

  it('after the window the guard is off: the button is enabled again, and listeners are told', () => {
    const { time, store } = storeAt(0);
    const listener = vi.fn();
    store.subscribe(listener);
    store.press();
    expect(listener).toHaveBeenCalledTimes(1);

    time.advance(UNINSTALL_GUARD_MS - 1);
    expect(store.getState()).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);

    time.advance(1);
    expect(store.getState()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.press()).toBe(true);
  });

  it('a second press while the guard holds is ignored: nothing changes and the window does not restart', () => {
    const { time, store } = storeAt(0);
    store.press();
    time.advance(5_000);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.press()).toBe(false);
    expect(store.getState()).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(time.pending()).toBe(1);

    time.advance(UNINSTALL_GUARD_MS - 5_000);
    expect(store.getState()).toBeNull();
  });

  it('a press after the window is over is accepted even when its timer has not run yet', () => {
    const { time, store } = storeAt(0);
    store.press();
    time.set(UNINSTALL_GUARD_MS + 1);
    expect(store.press()).toBe(true);
    expect(store.getState()).toBe(UNINSTALL_GUARD_MS + 1);
    // The superseded timer is cancelled: exactly one timer, for the new window.
    expect(time.pending()).toBe(1);
  });

  it('a timer that wakes before the window is over, by the clock, waits for the rest of it', () => {
    const { time, store } = storeAt(0);
    store.press();
    time.set(3_000);
    time.runPending();
    expect(store.getState()).toBe(0);
    expect(store.press()).toBe(false);

    time.advance(UNINSTALL_GUARD_MS - 3_000 - 1);
    expect(store.getState()).toBe(0);
    time.advance(1);
    expect(store.getState()).toBeNull();
  });
});
