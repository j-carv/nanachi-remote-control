import { createHash } from 'node:crypto';
import { messageOf } from '../common/message.js';

/**
 * The embedded PWA keeps a service worker and Cache Storage for the daemon's origin. Its precache serves the build that was
 * current when it was installed, so after Desktop is updated the first load can show the old UI. Before each load this module
 * compares the build the daemon serves now with the one the cache was last cleared for, and clears the cache when they differ.
 * The decisions are here; the Electron call is injected (`clear`), so all of it runs under vitest.
 */

/** The build the cache was last cleared for: the daemon origin, and the fingerprint of the page it served. */
export interface PwaBuild {
  origin: string;
  fingerprint: string;
}

/** What the refresh did: `same` and `unreadable` change nothing; `cleared` remembers the build; `failed` remembers nothing. */
export type PwaCacheOutcome = 'same' | 'unreadable' | 'cleared' | 'failed';

export type PwaCacheDecision =
  /** The daemon did not say which build it serves: nothing changes, the next load asks again. */
  | { kind: 'unreadable' }
  /** The stored build is the served one on the same origin: nothing changes. */
  | { kind: 'same' }
  /** Another build, another origin or no stored build: clear the cache, then remember this build. */
  | { kind: 'clear'; fingerprint: string };

/** The subset of `fetch` this module uses; the global `fetch` fits it. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The daemon is on loopback: an answer that takes longer than this means it is not ready, and the load goes on without the check. */
export const FINGERPRINT_TIMEOUT_MS = 2_000;

/** The fingerprint of a PWA build: the sha256 of its `index.html` in hex. Vite names the assets by hash, so the page changes with them. */
export function fingerprintOf(indexHtml: string): string {
  return createHash('sha256').update(indexHtml, 'utf8').digest('hex');
}

/** Whether `value` has the shape of a fingerprint (64 lowercase hex digits). */
export function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The fingerprint of the page the daemon serves at its origin root (the URL the view loads), read without the service worker
 * (this is the main process). Null when nothing usable answers: the daemon is down, slow, or has no build. Never throws.
 */
export async function readCurrentFingerprint(
  origin: string,
  options: { fetchImpl: FetchLike; timeoutMs?: number },
): Promise<string | null> {
  try {
    const response = await options.fetchImpl(`${origin}/`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? FINGERPRINT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return fingerprintOf(await response.text());
  } catch {
    return null;
  }
}

export function decidePwaCache(input: { stored: PwaBuild | undefined; origin: string; current: string | null }): PwaCacheDecision {
  if (input.current === null) return { kind: 'unreadable' };
  const { stored } = input;
  if (stored !== undefined && stored.origin === input.origin && stored.fingerprint === input.current) return { kind: 'same' };
  return { kind: 'clear', fingerprint: input.current };
}

export interface PwaCacheDeps {
  /** `http://127.0.0.1:<port>` of the daemon, read on every refresh because the port can move. */
  origin(): string;
  fetchImpl: FetchLike;
  /** The build the cache was last cleared for, as stored in Desktop's settings. */
  stored(): PwaBuild | undefined;
  /** Remembers the build the cache was just cleared for. */
  store(build: PwaBuild): void;
  /** Clears the service workers and Cache Storage of `origin`; its local storage, IndexedDB and cookies are kept. */
  clear(origin: string): Promise<void>;
  /** Logs a line through Desktop's log. */
  note(text: string): void;
  timeoutMs?: number;
}

/**
 * Returns the refresh to run before every load of the PWA. It never rejects: a failure is logged and the load goes on. Calls
 * that overlap share one run, so a second clear cannot wipe a service worker that the first load has already installed.
 */
export function createPwaCacheRefresh(deps: PwaCacheDeps): () => Promise<PwaCacheOutcome> {
  let running: Promise<PwaCacheOutcome> | null = null;

  async function run(): Promise<PwaCacheOutcome> {
    try {
      const origin = deps.origin();
      const current = await readCurrentFingerprint(origin, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs ?? FINGERPRINT_TIMEOUT_MS });
      const decision = decidePwaCache({ stored: deps.stored(), origin, current });
      if (decision.kind === 'unreadable') return 'unreadable';
      if (decision.kind === 'same') return 'same';
      await deps.clear(origin);
      deps.store({ origin, fingerprint: decision.fingerprint });
      deps.note(`cache do service worker da PWA limpo (build ${decision.fingerprint.slice(0, 12)})`);
      return 'cleared';
    } catch (error) {
      // Nothing was remembered, so the next load tries again.
      deps.note(`não foi possível atualizar o cache da PWA: ${messageOf(error)}`);
      return 'failed';
    }
  }

  return () => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };
}
