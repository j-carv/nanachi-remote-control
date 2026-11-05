import { describe, expect, it } from 'vitest';
import {
  createPwaCacheRefresh,
  decidePwaCache,
  fingerprintOf,
  isFingerprint,
  readCurrentFingerprint,
  type FetchLike,
  type PwaBuild,
  type PwaCacheDeps,
} from '../src/main/pwa-cache.js';

const ORIGIN = 'http://127.0.0.1:7780';
const OTHER_ORIGIN = 'http://127.0.0.1:7777';
const OLD_HTML = '<!doctype html><script type="module" src="/assets/index-old.js"></script>';
const NEW_HTML = '<!doctype html><script type="module" src="/assets/index-new.js"></script>';
const OLD = fingerprintOf(OLD_HTML);
const NEW = fingerprintOf(NEW_HTML);

describe('fingerprint of a PWA build', () => {
  it('is the sha256 of the served index.html, in lowercase hex', () => {
    expect(fingerprintOf('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(OLD).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for another page', () => {
    expect(NEW).not.toBe(OLD);
  });

  it('accepts only a 64-digit lowercase hex string', () => {
    expect(isFingerprint(OLD)).toBe(true);
    expect(isFingerprint(OLD.toUpperCase())).toBe(false);
    expect(isFingerprint(OLD.slice(1))).toBe(false);
    expect(isFingerprint(undefined)).toBe(false);
    expect(isFingerprint(42)).toBe(false);
  });
});

describe('reading the build the daemon serves', () => {
  it('fingerprints the origin root, the same URL the view loads', async () => {
    const seen: string[] = [];
    const fetchImpl: FetchLike = (url) => {
      seen.push(url);
      return Promise.resolve(new Response(OLD_HTML, { status: 200 }));
    };
    expect(await readCurrentFingerprint(ORIGIN, { fetchImpl })).toBe(OLD);
    expect(seen).toEqual([`${ORIGIN}/`]);
  });

  it('gives null for an error answer, so an unbuilt daemon is not fingerprinted', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(new Response('PWA não compilada', { status: 404 }));
    expect(await readCurrentFingerprint(ORIGIN, { fetchImpl })).toBeNull();
  });

  it('gives null when nothing answers', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    expect(await readCurrentFingerprint(ORIGIN, { fetchImpl })).toBeNull();
  });

  it('gives null when the daemon is too slow, and gives up at the timeout', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const started = Date.now();
    expect(await readCurrentFingerprint(ORIGIN, { fetchImpl, timeoutMs: 20 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('deciding whether the service worker must be cleared', () => {
  const stored: PwaBuild = { origin: ORIGIN, fingerprint: OLD };

  it('keeps everything when the stored build is the one served on the same origin', () => {
    expect(decidePwaCache({ stored, origin: ORIGIN, current: OLD })).toEqual({ kind: 'same' });
  });

  it('clears and remembers the new build when the served build changed', () => {
    expect(decidePwaCache({ stored, origin: ORIGIN, current: NEW })).toEqual({ kind: 'clear', fingerprint: NEW });
  });

  it('clears on the first run, when nothing is stored yet', () => {
    expect(decidePwaCache({ stored: undefined, origin: ORIGIN, current: NEW })).toEqual({ kind: 'clear', fingerprint: NEW });
  });

  it('clears again when the daemon moved to another origin, even with the same build', () => {
    expect(decidePwaCache({ stored, origin: OTHER_ORIGIN, current: OLD })).toEqual({ kind: 'clear', fingerprint: OLD });
  });

  it('does nothing when the served build cannot be read, so the next load asks again', () => {
    expect(decidePwaCache({ stored, origin: ORIGIN, current: null })).toEqual({ kind: 'unreadable' });
    expect(decidePwaCache({ stored: undefined, origin: ORIGIN, current: null })).toEqual({ kind: 'unreadable' });
  });
});

interface Harness {
  refresh: () => Promise<string>;
  cleared: string[];
  saved: PwaBuild[];
  notes: string[];
  serve(html: string | null): void;
  moveTo(origin: string): void;
  failClearWith(error: Error | null): void;
}

function setup(initial: { stored?: PwaBuild; served?: string | null; origin?: string } = {}): Harness {
  let stored: PwaBuild | undefined = initial.stored;
  let served: string | null = initial.served === undefined ? NEW_HTML : initial.served;
  let origin = initial.origin ?? ORIGIN;
  let clearError: Error | null = null;
  const cleared: string[] = [];
  const saved: PwaBuild[] = [];
  const notes: string[] = [];
  const deps: PwaCacheDeps = {
    origin: () => origin,
    fetchImpl: () => (served === null ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(new Response(served, { status: 200 }))),
    stored: () => stored,
    store: (build) => {
      stored = build;
      saved.push(build);
    },
    clear: (target) => {
      cleared.push(target);
      return clearError === null ? Promise.resolve() : Promise.reject(clearError);
    },
    note: (text) => {
      notes.push(text);
    },
  };
  const refresh = createPwaCacheRefresh(deps);
  return {
    refresh,
    cleared,
    saved,
    notes,
    serve: (html) => {
      served = html;
    },
    moveTo: (next) => {
      origin = next;
    },
    failClearWith: (error) => {
      clearError = error;
    },
  };
}

describe('refreshing the PWA cache before a load', () => {
  it('clears the origin and remembers the build on the first run', async () => {
    const h = setup();
    expect(await h.refresh()).toBe('cleared');
    expect(h.cleared).toEqual([ORIGIN]);
    expect(h.saved).toEqual([{ origin: ORIGIN, fingerprint: NEW }]);
    expect(h.notes).toHaveLength(1);
  });

  it('touches nothing when the served build is the stored one', async () => {
    const h = setup({ stored: { origin: ORIGIN, fingerprint: NEW } });
    expect(await h.refresh()).toBe('same');
    expect(h.cleared).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('clears after an update: the stored build is the old one', async () => {
    const h = setup({ stored: { origin: ORIGIN, fingerprint: OLD } });
    expect(await h.refresh()).toBe('cleared');
    expect(h.cleared).toEqual([ORIGIN]);
    expect(h.saved).toEqual([{ origin: ORIGIN, fingerprint: NEW }]);
  });

  it('does nothing when the daemon cannot be read, and says nothing', async () => {
    const h = setup({ stored: { origin: ORIGIN, fingerprint: OLD }, served: null });
    expect(await h.refresh()).toBe('unreadable');
    expect(h.cleared).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it('reads the origin on every refresh, so a daemon that moved is followed', async () => {
    const h = setup({ stored: { origin: ORIGIN, fingerprint: NEW } });
    h.moveTo(OTHER_ORIGIN);
    expect(await h.refresh()).toBe('cleared');
    expect(h.cleared).toEqual([OTHER_ORIGIN]);
    expect(h.saved).toEqual([{ origin: OTHER_ORIGIN, fingerprint: NEW }]);
  });

  it('never rejects when the clear fails: it is logged, nothing is remembered, and the next load tries again', async () => {
    const h = setup({ stored: { origin: ORIGIN, fingerprint: OLD } });
    h.failClearWith(new Error('arquivo em uso'));
    expect(await h.refresh()).toBe('failed');
    expect(h.saved).toEqual([]);
    expect(h.notes.join('\n')).toContain('arquivo em uso');

    h.failClearWith(null);
    expect(await h.refresh()).toBe('cleared');
    expect(h.cleared).toEqual([ORIGIN, ORIGIN]);
    expect(h.saved).toEqual([{ origin: ORIGIN, fingerprint: NEW }]);
  });

  it('runs once for calls that overlap, so a second clear cannot wipe a service worker that is already back', async () => {
    const h = setup();
    const [first, second] = await Promise.all([h.refresh(), h.refresh()]);
    expect(first).toBe('cleared');
    expect(second).toBe('cleared');
    expect(h.cleared).toEqual([ORIGIN]);
  });
});
