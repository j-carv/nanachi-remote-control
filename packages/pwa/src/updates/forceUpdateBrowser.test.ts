import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestPrecacheRefill, REFILL_TIMEOUT_MS } from './forceUpdateBrowser.js';
import { REFILL_PRECACHE_MESSAGE, type ActiveWorkerLike } from './forceUpdate.js';

/** Fake active worker: keeps the port sent with the message so the test can answer through it. */
function fakeActiveWorker(): { worker: ActiveWorkerLike; messages: unknown[]; port(): MessagePort } {
  const messages: unknown[] = [];
  const ports: MessagePort[] = [];
  const worker: ActiveWorkerLike = {
    state: 'activated',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    postMessage: (message, transfer) => {
      messages.push(message);
      for (const item of transfer) {
        if (item instanceof MessagePort) ports.push(item);
      }
    },
  };
  return {
    worker,
    messages,
    port: () => {
      const [port] = ports;
      if (port === undefined) throw new Error('no port received');
      return port;
    },
  };
}

describe('requestPrecacheRefill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts the refill message and resolves when the service worker answers true', async () => {
    const fake = fakeActiveWorker();
    const done = requestPrecacheRefill(fake.worker);

    expect(fake.messages).toEqual([{ type: REFILL_PRECACHE_MESSAGE }]);
    fake.port().postMessage(true);

    await expect(done).resolves.toBeUndefined();
  });

  it('rejects when the service worker answers anything other than true', async () => {
    const fake = fakeActiveWorker();
    const done = requestPrecacheRefill(fake.worker);
    fake.port().postMessage(false);

    await expect(done).rejects.toThrow('refill recusado');
  });

  it('rejects after the deadline when the service worker does not answer', async () => {
    const fake = fakeActiveWorker();
    const done = requestPrecacheRefill(fake.worker);
    const assertion = expect(done).rejects.toThrow('sem resposta do service worker');

    await vi.advanceTimersByTimeAsync(REFILL_TIMEOUT_MS);

    await assertion;
  });
});
