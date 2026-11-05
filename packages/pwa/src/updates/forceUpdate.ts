/** Longest wait for the new service worker to activate before the current one is unregistered. */
export const FORCE_UPDATE_TIMEOUT_MS = 15_000;

/** Message the page posts to the service worker to refill the precache (see `sw.ts`). */
export const REFILL_PRECACHE_MESSAGE = 'refill-precache';

export type ForceUpdatePhase = 'checking' | 'downloading' | 'clearing' | 'reloading';

/** The part of `ServiceWorker` the orchestration uses. A real worker satisfies it as is. */
export interface WorkerLike {
  readonly state: ServiceWorkerState;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

export interface ActiveWorkerLike extends WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

/** The part of `ServiceWorkerRegistration` the orchestration uses. */
export interface RegistrationLike {
  readonly installing: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  readonly active: ActiveWorkerLike | null;
  update(): Promise<unknown>;
  unregister(): Promise<boolean>;
}

/** Everything the orchestration touches in the browser, injected so tests can replace it with fakes. */
export interface ForceUpdateEnv {
  /** The app's service worker registration, or `null` when there is none (no support, nothing registered). */
  getRegistration(): Promise<RegistrationLike | null>;
  /** Deletes every Cache Storage cache. Never touches localStorage. */
  deleteAllCaches(): Promise<void>;
  /** Asks the active service worker to refill the precache in the empty caches. */
  refillPrecache(worker: ActiveWorkerLike): Promise<void>;
  /** Reloads with a cache-busting navigation (`location.replace`). */
  reload(): void;
}

/** A failure before the reload. `message` is the reason in Portuguese, shown to the user. */
export class ForceUpdateError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'ForceUpdateError';
  }
}

const REASON = {
  registration: 'o navegador não respondeu ao service worker',
  update: 'sem conexão para verificar a versão nova',
  caches: 'não foi possível apagar o cache',
  refill: 'não foi possível recarregar os arquivos do app',
  unregister: 'não foi possível reiniciar o service worker',
} as const;

type ActivationOutcome = 'activated' | 'redundant' | 'timeout';

/** Waits until the worker reaches `activated` or `redundant`, or the deadline passes. Stops listening when done. */
export function awaitActivation(worker: WorkerLike, timeoutMs: number): Promise<ActivationOutcome> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: ActivationOutcome): void => {
      if (timer !== undefined) clearTimeout(timer);
      worker.removeEventListener('statechange', onChange);
      resolve(outcome);
    };
    function onChange(): void {
      if (worker.state === 'activated') settle('activated');
      else if (worker.state === 'redundant') settle('redundant');
    }
    timer = setTimeout(() => settle('timeout'), timeoutMs);
    worker.addEventListener('statechange', onChange);
    onChange();
  });
}

/** Trimmed view of `CacheStorage` that the cleanup uses. */
export interface CacheStorageLike {
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

/**
 * Deletes every listed cache, without a filter. The app's caches hold only build files; no user data lives there.
 */
export async function deleteAllCaches(storage: CacheStorageLike): Promise<void> {
  const names = await storage.keys();
  await Promise.all(names.map((name) => storage.delete(name)));
}

/** True when `data` is the message the page posts to ask for a precache refill. */
export function isRefillPrecacheRequest(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === REFILL_PRECACHE_MESSAGE;
}

/** Runs one step and turns its failure into a Portuguese reason. The original error is kept in `cause`. */
async function step<T>(reason: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ForceUpdateError(reason, { cause: error });
  }
}

/**
 * Forced update of the app, in this order:
 * 1. Look for a new version (`registration.update()`). If a new worker is installing or waiting, wait up to
 *    15 s for it to activate. The app's service worker calls `skipWaiting` itself, so no message is needed.
 * 2. Delete every Cache Storage cache. User data lives in localStorage and is not touched.
 * 3. With the service worker kept active, refill the precache in the empty caches (otherwise the app loses its
 *    offline files). If activation timed out or the new worker went redundant, unregister instead; the next page
 *    load registers and installs the service worker again.
 * 4. Reload with a cache-busting navigation.
 *
 * A failure before the reload throws `ForceUpdateError`. The page keeps running as it was: the current document
 * stays in memory, and the current service worker is untouched (unregistering only happens after the wait).
 */
export async function runForceUpdate(
  env: ForceUpdateEnv,
  onPhase: (phase: ForceUpdatePhase) => void,
  timeoutMs: number = FORCE_UPDATE_TIMEOUT_MS,
): Promise<void> {
  onPhase('checking');
  const registration = await step(REASON.registration, () => env.getRegistration());
  let keepWorker = true;

  if (registration !== null) {
    await step(REASON.update, () => registration.update());
    const pending = registration.installing ?? registration.waiting;
    if (pending !== null) {
      onPhase('downloading');
      const outcome = await awaitActivation(pending, timeoutMs);
      keepWorker = outcome === 'activated';
    }
  }

  onPhase('clearing');
  await step(REASON.caches, () => env.deleteAllCaches());

  if (registration !== null) {
    if (keepWorker) {
      const active = registration.active;
      if (active !== null) await step(REASON.refill, () => env.refillPrecache(active));
    } else {
      await step(REASON.unregister, () => registration.unregister());
    }
  }

  onPhase('reloading');
  env.reload();
}
