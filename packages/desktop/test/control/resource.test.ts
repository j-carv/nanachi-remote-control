import { describe, expect, it } from 'vitest';
import type { ControlError, ControlResult } from '../../src/common/control-api.js';
import { createResourceCore, type ResourceState } from '../../src/control/state/resource-core.js';

/** A call whose answer the test releases by hand, so the order of the answers is the test's to decide. */
function gate<T>() {
  const pending: Array<(result: ControlResult<T>) => void> = [];
  const load = (): Promise<ControlResult<T>> => new Promise((resolve) => pending.push(resolve));
  return {
    load,
    calls: () => pending.length,
    answer(index: number, value: T): void {
      pending[index]?.({ ok: true, value });
    },
    fail(index: number, error: ControlError): void {
      pending[index]?.(error);
    },
  };
}

const down: ControlError = { ok: false, code: 'daemon_unavailable', message: 'O daemon não respondeu.' };

function recordStates<T>(core: ReturnType<typeof createResourceCore<T>>): Array<ResourceState<T>> {
  const seen: Array<ResourceState<T>> = [];
  core.subscribe(() => seen.push(core.getState()));
  return seen;
}

describe('createResourceCore', () => {
  it('starts loading, then holds the answer', async () => {
    const g = gate<number>();
    const core = createResourceCore({ load: g.load });
    expect(core.getState()).toEqual({ status: 'loading' });
    const done = core.reload();
    g.answer(0, 7);
    await done;
    expect(core.getState()).toEqual({ status: 'ready', data: 7 });
  });

  it('only the latest request lands: a slow answer to an older request is dropped', async () => {
    const g = gate<string>();
    const core = createResourceCore({ load: g.load });
    const first = core.reload();
    const second = core.reload(true);
    g.answer(1, 'novo');
    await second;
    g.answer(0, 'velho');
    await first;
    expect(core.getState()).toEqual({ status: 'ready', data: 'novo' });
  });

  it('an older failure does not replace a newer answer either', async () => {
    const g = gate<string>();
    const core = createResourceCore({ load: g.load });
    const first = core.reload();
    const second = core.reload();
    g.answer(1, 'ok');
    await second;
    g.fail(0, down);
    await first;
    expect(core.getState()).toEqual({ status: 'ready', data: 'ok' });
  });

  it('a call that rejects becomes an error state, never an unhandled rejection', async () => {
    const core = createResourceCore<number>({ load: () => Promise.reject(new Error('Error invoking remote method')) });
    await core.reload();
    expect(core.getState()).toMatchObject({ status: 'error', error: { ok: false, code: 'unknown' } });
  });

  it('a silent reload keeps what is on screen: no loading flash, and a failure is ignored while there is data', async () => {
    const g = gate<number>();
    const core = createResourceCore({ load: g.load });
    const first = core.reload();
    g.answer(0, 1);
    await first;
    const seen = recordStates(core);

    const silent = core.reload(true);
    expect(core.getState()).toEqual({ status: 'ready', data: 1 });
    g.fail(1, down);
    await silent;
    expect(core.getState()).toEqual({ status: 'ready', data: 1 });
    expect(seen).toEqual([]);
  });

  it('a silent reload still shows the error when there was nothing to keep, and a loud one always does', async () => {
    const g = gate<number>();
    const core = createResourceCore({ load: g.load });
    const first = core.reload(true);
    g.fail(0, down);
    await first;
    expect(core.getState()).toEqual({ status: 'error', error: down });

    const ok = core.reload();
    g.answer(1, 5);
    await ok;
    const loud = core.reload();
    expect(core.getState()).toEqual({ status: 'loading' });
    g.fail(2, down);
    await loud;
    expect(core.getState()).toEqual({ status: 'error', error: down });
  });

  it('an answer equal to the current data keeps the same state object (a poll that found nothing new changes nothing)', async () => {
    const g = gate<{ n: number }>();
    const core = createResourceCore({ load: g.load, equals: (a, b) => (a as { n: number }).n === (b as { n: number }).n });
    const first = core.reload();
    g.answer(0, { n: 1 });
    await first;
    const before = core.getState();
    const seen = recordStates(core);
    const again = core.reload(true);
    g.answer(1, { n: 1 });
    await again;
    expect(core.getState()).toBe(before);
    expect(seen).toEqual([]);
    const changed = core.reload(true);
    g.answer(2, { n: 2 });
    await changed;
    expect(core.getState()).toEqual({ status: 'ready', data: { n: 2 } });
  });

  it('setData replaces the data, and an answer that was already on its way (older than the mutation) is dropped', async () => {
    const g = gate<string[]>();
    const core = createResourceCore({ load: g.load });
    const poll = core.reload(true);
    // The user saves while the poll is in flight: the answer of the save is newer than the poll.
    core.setData(['depois']);
    g.answer(0, ['antes']);
    await poll;
    expect(core.getState()).toEqual({ status: 'ready', data: ['depois'] });
  });

  it('drops the answers that arrive after its owner went away, and works again when the owner comes back', async () => {
    const g = gate<number>();
    const core = createResourceCore({ load: g.load });
    const seen = recordStates(core);
    const first = core.reload();
    core.setActive(false);
    g.answer(0, 1);
    await first;
    expect(core.getState()).toEqual({ status: 'loading' });
    expect(seen.filter((state) => state.status === 'ready')).toEqual([]);

    core.setActive(true);
    const second = core.reload();
    g.answer(1, 2);
    await second;
    expect(core.getState()).toEqual({ status: 'ready', data: 2 });
  });

  it('tells its subscribers about every change and about nothing else, and stops when they leave', async () => {
    const g = gate<number>();
    const core = createResourceCore({ load: g.load });
    let notified = 0;
    const off = core.subscribe(() => {
      notified += 1;
    });
    const first = core.reload();
    g.answer(0, 1);
    await first;
    expect(notified).toBe(1);
    // Loading was already the state: asking again to load loudly changes nothing until the answer.
    off();
    core.setData(2);
    expect(notified).toBe(1);
  });
});
