import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitActivation,
  deleteAllCaches,
  FORCE_UPDATE_TIMEOUT_MS,
  ForceUpdateError,
  isRefillPrecacheRequest,
  REFILL_PRECACHE_MESSAGE,
  runForceUpdate,
  type ActiveWorkerLike,
  type ForceUpdateEnv,
  type ForceUpdatePhase,
  type RegistrationLike,
  type WorkerLike,
} from './forceUpdate.js';

/** Fake worker: changes state through `setState` and notifies the `statechange` listeners. */
class FakeWorker implements ActiveWorkerLike {
  state: ServiceWorkerState;
  readonly messages: unknown[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(state: ServiceWorkerState) {
    this.state = state;
  }

  setState(state: ServiceWorkerState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  addEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'statechange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

interface FakeRegistration extends RegistrationLike {
  installing: FakeWorker | null;
  waiting: FakeWorker | null;
  active: FakeWorker | null;
}

/** Fake registration. `onUpdate` runs inside `update()` to simulate a new version arriving. */
function fakeRegistration(options: {
  active?: FakeWorker | null;
  onUpdate?: (registration: FakeRegistration) => void;
  updateError?: Error;
}): FakeRegistration {
  const registration: FakeRegistration = {
    installing: null,
    waiting: null,
    active: options.active === undefined ? new FakeWorker('activated') : options.active,
    update: vi.fn(async () => {
      if (options.updateError !== undefined) throw options.updateError;
      options.onUpdate?.(registration);
    }),
    unregister: vi.fn(async () => true),
  };
  return registration;
}

interface FakeEnv {
  getRegistration: ReturnType<typeof vi.fn<() => Promise<RegistrationLike | null>>>;
  deleteAllCaches: ReturnType<typeof vi.fn<() => Promise<void>>>;
  refillPrecache: ReturnType<typeof vi.fn<(worker: ActiveWorkerLike) => Promise<void>>>;
  reload: ReturnType<typeof vi.fn<() => void>>;
}

function fakeEnv(registration: RegistrationLike | null): FakeEnv & ForceUpdateEnv {
  return {
    getRegistration: vi.fn(async () => registration),
    deleteAllCaches: vi.fn(async () => undefined),
    refillPrecache: vi.fn(async () => undefined),
    reload: vi.fn(),
  };
}

/** Records the phases the orchestration reports, in order. */
function recordPhases(): { phases: ForceUpdatePhase[]; onPhase: (phase: ForceUpdatePhase) => void } {
  const phases: ForceUpdatePhase[] = [];
  return { phases, onPhase: (phase) => phases.push(phase) };
}

describe('runForceUpdate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('new version found: waits for activation, deletes the caches, refills the precache and reloads without unregistering', async () => {
    const newWorker = new FakeWorker('installing');
    const registration = fakeRegistration({
      onUpdate: (reg) => {
        reg.installing = newWorker;
        // The new service worker calls skipWaiting: it installs and activates right after.
        queueMicrotask(() => {
          newWorker.setState('installed');
          newWorker.setState('activated');
        });
      },
    });
    const env = fakeEnv(registration);
    const { phases, onPhase } = recordPhases();

    await runForceUpdate(env, onPhase);

    expect(registration.update).toHaveBeenCalledOnce();
    expect(phases).toEqual(['checking', 'downloading', 'clearing', 'reloading']);
    expect(env.deleteAllCaches).toHaveBeenCalledOnce();
    expect(env.refillPrecache).toHaveBeenCalledWith(registration.active);
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(env.reload).toHaveBeenCalledOnce();
  });

  it('no new version: does not wait, deletes the caches, refills and reloads', async () => {
    const registration = fakeRegistration({});
    const env = fakeEnv(registration);
    const { phases, onPhase } = recordPhases();

    await runForceUpdate(env, onPhase);

    expect(phases).toEqual(['checking', 'clearing', 'reloading']);
    expect(env.deleteAllCaches).toHaveBeenCalledOnce();
    expect(env.refillPrecache).toHaveBeenCalledOnce();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(env.reload).toHaveBeenCalledOnce();
  });

  it('new worker still installing after 15 s: unregisters, skips the refill and reloads', async () => {
    const stuck = new FakeWorker('installing');
    const registration = fakeRegistration({
      onUpdate: (reg) => {
        reg.installing = stuck;
      },
    });
    const env = fakeEnv(registration);

    const run = runForceUpdate(env, recordPhases().onPhase);
    await vi.advanceTimersByTimeAsync(FORCE_UPDATE_TIMEOUT_MS);
    await run;

    expect(registration.unregister).toHaveBeenCalledOnce();
    expect(env.refillPrecache).not.toHaveBeenCalled();
    expect(env.deleteAllCaches).toHaveBeenCalledOnce();
    expect(env.reload).toHaveBeenCalledOnce();
  });

  it('new worker goes redundant (install failed): unregisters and reloads', async () => {
    const broken = new FakeWorker('installing');
    const registration = fakeRegistration({
      onUpdate: (reg) => {
        reg.installing = broken;
        queueMicrotask(() => broken.setState('redundant'));
      },
    });
    const env = fakeEnv(registration);

    await runForceUpdate(env, recordPhases().onPhase);

    expect(registration.unregister).toHaveBeenCalledOnce();
    expect(env.reload).toHaveBeenCalledOnce();
  });

  it('no service worker registration: deletes the caches and reloads without touching a registration', async () => {
    const env = fakeEnv(null);

    await runForceUpdate(env, recordPhases().onPhase);

    expect(env.deleteAllCaches).toHaveBeenCalledOnce();
    expect(env.refillPrecache).not.toHaveBeenCalled();
    expect(env.reload).toHaveBeenCalledOnce();
  });

  it('update() fails (offline): shows the reason and leaves the caches, the registration and the page alone', async () => {
    const registration = fakeRegistration({ updateError: new TypeError('Failed to fetch') });
    const env = fakeEnv(registration);

    const failure = await runForceUpdate(env, recordPhases().onPhase).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ForceUpdateError);
    expect(failure).toHaveProperty('message', 'sem conexão para verificar a versão nova');
    expect(env.deleteAllCaches).not.toHaveBeenCalled();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('cache deletion fails: does not unregister and does not reload', async () => {
    const registration = fakeRegistration({});
    const env = fakeEnv(registration);
    env.deleteAllCaches.mockRejectedValueOnce(new Error('quota'));

    const failure = await runForceUpdate(env, recordPhases().onPhase).catch((error: unknown) => error);

    expect(failure).toHaveProperty('message', 'não foi possível apagar o cache');
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(env.reload).not.toHaveBeenCalled();
  });

  it('precache refill fails: does not reload (the app keeps running and a retry redoes everything)', async () => {
    const env = fakeEnv(fakeRegistration({}));
    env.refillPrecache.mockRejectedValueOnce(new Error('network'));

    const failure = await runForceUpdate(env, recordPhases().onPhase).catch((error: unknown) => error);

    expect(failure).toHaveProperty('message', 'não foi possível recarregar os arquivos do app');
    expect(env.reload).not.toHaveBeenCalled();
  });
});

describe('awaitActivation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves at once when the worker is already active', async () => {
    const worker: WorkerLike = new FakeWorker('activated');
    await expect(awaitActivation(worker, 1000)).resolves.toBe('activated');
  });

  it('resolves redundant when the worker fails', async () => {
    const worker = new FakeWorker('installing');
    const result = awaitActivation(worker, 1000);
    worker.setState('redundant');
    await expect(result).resolves.toBe('redundant');
  });

  it('resolves timeout and stops listening to the worker', async () => {
    const worker = new FakeWorker('installing');
    const result = awaitActivation(worker, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe('timeout');
    expect(worker.state).toBe('installing');
  });
});

describe('deleteAllCaches', () => {
  it('deletes every cache listed: the precache and the runtime caches alike', async () => {
    const names = ['workbox-precache-v2-http://app/', 'runtime-images', 'old-release'];
    const deleted: string[] = [];
    const storage = {
      keys: async () => [...names],
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    };

    await deleteAllCaches(storage);

    expect(deleted.sort()).toEqual([...names].sort());
  });

  it('deletes nothing when there are no caches', async () => {
    const storage = {
      keys: async () => [],
      delete: async () => true,
    };
    const deleteSpy = vi.spyOn(storage, 'delete');

    await deleteAllCaches(storage);

    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe('isRefillPrecacheRequest', () => {
  it('recognises the refill message and rejects everything else', () => {
    expect(isRefillPrecacheRequest({ type: REFILL_PRECACHE_MESSAGE })).toBe(true);
    expect(isRefillPrecacheRequest({ type: 'SKIP_WAITING' })).toBe(false);
    expect(isRefillPrecacheRequest('refill-precache')).toBe(false);
    expect(isRefillPrecacheRequest(null)).toBe(false);
    expect(isRefillPrecacheRequest(undefined)).toBe(false);
  });
});
