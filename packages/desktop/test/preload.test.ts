import { describe, expect, it, vi } from 'vitest';
import {
  parseMachines,
  readSelectedId,
  readStoredMachines,
  resolveSelected,
  MACHINES_KEY as PWA_MACHINES_KEY,
  SELECTED_KEY as PWA_SELECTED_KEY,
  type StorageLike as PwaStorage,
} from '../../pwa/src/machines.js';
import {
  ALLOWED_EVENT_CHANNELS,
  ALLOWED_INVOKE_CHANNELS,
  ALLOWED_SYNC_CHANNELS,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SYNC_CHANNELS,
} from '../src/common/channels.js';
import type { SeedMachine } from '../src/common/types.js';
import { createBridge, type BridgeIpc } from '../src/preload/bridge.js';
import { PWA_LANGUAGE_KEY } from '../src/common/i18n/index.js';
import { MACHINES_KEY, SELECTED_KEY, seedLanguage, seedMachines } from '../src/preload/seed.js';
import { LANGUAGE_KEY as PWA_OWN_LANGUAGE_KEY } from '../../pwa/src/i18n/languages.js';

describe('channel allowlist', () => {
  it('is a fixed, prefixed, duplicate-free list', () => {
    const all = [...Object.values(INVOKE_CHANNELS), ...Object.values(EVENT_CHANNELS), ...Object.values(SYNC_CHANNELS)];
    expect(all.every((channel) => channel.startsWith('desktop:'))).toBe(true);
    expect(new Set(all).size).toBe(all.length);
    expect(ALLOWED_INVOKE_CHANNELS.size).toBe(Object.keys(INVOKE_CHANNELS).length);
    expect(ALLOWED_EVENT_CHANNELS.size).toBe(Object.keys(EVENT_CHANNELS).length);
    expect(ALLOWED_SYNC_CHANNELS.size).toBe(1);
  });
});

interface FakeIpc extends BridgeIpc {
  invoked: Array<{ channel: string; args: unknown[] }>;
  listeners: Map<string, Set<(event: unknown, ...args: unknown[]) => void>>;
  emit(channel: string, payload: unknown): void;
}

function fakeIpc(): FakeIpc {
  const listeners: FakeIpc['listeners'] = new Map();
  const invoked: FakeIpc['invoked'] = [];
  return {
    invoked,
    listeners,
    invoke(channel, ...args) {
      invoked.push({ channel, args });
      return Promise.resolve({ echoed: channel });
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) listener({ sender: 'secret-ipc-event' }, payload);
    },
  };
}

describe('bridge', () => {
  it('exposes exactly the contract surface and nothing else', () => {
    const bridge = createBridge(fakeIpc(), '0.1.0');
    expect(Object.keys(bridge).sort()).toEqual(
      ['checkForUpdate', 'getAutostart', 'onLanguage', 'onStatus', 'pairingCode', 'setAutostart', 'status', 'tailscale', 'version'].sort(),
    );
    expect(Object.keys(bridge.tailscale).sort()).toEqual(['onStatus', 'start', 'status', 'stop']);
    expect(bridge.version).toBe('0.1.0');
  });

  it('every method uses only channels from the allowlist', async () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc, '0.1.0');
    await bridge.status();
    await bridge.pairingCode();
    await bridge.getAutostart();
    await bridge.setAutostart(true);
    await bridge.checkForUpdate();
    await bridge.tailscale.status();
    await bridge.tailscale.start();
    await bridge.tailscale.stop();
    bridge.onStatus(() => undefined);
    bridge.tailscale.onStatus(() => undefined);
    bridge.onLanguage(() => undefined);

    expect(ipc.invoked.map((call) => call.channel)).toEqual([
      INVOKE_CHANNELS.status,
      INVOKE_CHANNELS.pairingCode,
      INVOKE_CHANNELS.getAutostart,
      INVOKE_CHANNELS.setAutostart,
      INVOKE_CHANNELS.checkForUpdate,
      INVOKE_CHANNELS.tailscaleStatus,
      INVOKE_CHANNELS.tailscaleStart,
      INVOKE_CHANNELS.tailscaleStop,
    ]);
    for (const { channel } of ipc.invoked) expect(ALLOWED_INVOKE_CHANNELS.has(channel)).toBe(true);
    expect([...ipc.listeners.keys()].sort()).toEqual([EVENT_CHANNELS.status, EVENT_CHANNELS.tailscaleStatus, EVENT_CHANNELS.language].sort());
    for (const channel of ipc.listeners.keys()) expect(ALLOWED_EVENT_CHANNELS.has(channel)).toBe(true);
  });

  it('forwards only the value the page gave, to setAutostart', async () => {
    const ipc = fakeIpc();
    await createBridge(ipc, '0.1.0').setAutostart(false);
    expect(ipc.invoked[0]).toEqual({ channel: INVOKE_CHANNELS.setAutostart, args: [false] });
  });

  it('hands the page the payload, never the IPC event, and unsubscribes with the same listener', () => {
    const ipc = fakeIpc();
    const bridge = createBridge(ipc, '0.1.0');
    const callback = vi.fn();
    const off = bridge.onStatus(callback);

    ipc.emit(EVENT_CHANNELS.status, { state: 'running' });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ state: 'running' });

    off();
    ipc.emit(EVENT_CHANNELS.status, { state: 'stopped' });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(ipc.listeners.get(EVENT_CHANNELS.status)?.size).toBe(0);
  });

  it('tailscale.onStatus listens on its own channel', () => {
    const ipc = fakeIpc();
    const callback = vi.fn();
    createBridge(ipc, '0.1.0').tailscale.onStatus(callback);
    ipc.emit(EVENT_CHANNELS.status, { state: 'running' });
    expect(callback).not.toHaveBeenCalled();
    ipc.emit(EVENT_CHANNELS.tailscaleStatus, { state: 'off' });
    expect(callback).toHaveBeenCalledWith({ state: 'off' });
  });

  it('onLanguage listens on its own channel and hands the page the language', () => {
    const ipc = fakeIpc();
    const callback = vi.fn();
    const off = createBridge(ipc, '0.1.0').onLanguage(callback);
    ipc.emit(EVENT_CHANNELS.status, { state: 'running' });
    expect(callback).not.toHaveBeenCalled();
    ipc.emit(EVENT_CHANNELS.language, 'es');
    expect(callback).toHaveBeenCalledWith('es');
    off();
    ipc.emit(EVENT_CHANNELS.language, 'en');
    expect(callback).toHaveBeenCalledTimes(1);
    expect(EVENT_CHANNELS.language).toBe('desktop:language-changed');
  });

  it('refuses a callback that is not a function', () => {
    const bridge = createBridge(fakeIpc(), '0.1.0');
    expect(() => bridge.onStatus('nope' as never)).toThrow(TypeError);
  });
});

/** In-memory `Storage`, usable both by the preload seed and by the PWA's own readers. */
class MemoryStorage implements PwaStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const ORIGIN = 'http://127.0.0.1:7811';
const DESKTOP: SeedMachine = { id: 'machine-1', name: 'OFFICE-PC', baseUrl: ORIGIN, token: 'token-1' };

describe('machine seed, checked against the PWA reader', () => {
  it('uses the same storage keys as the PWA', () => {
    expect(MACHINES_KEY).toBe(PWA_MACHINES_KEY);
    expect(SELECTED_KEY).toBe(PWA_SELECTED_KEY);
  });

  it('on a fresh profile the PWA reads one valid machine and selects it', () => {
    const storage = new MemoryStorage();
    expect(seedMachines(storage, DESKTOP, ORIGIN)).toBe('seeded');

    const stored = readStoredMachines(storage);
    expect(stored).toEqual({ status: 'ok', machines: [DESKTOP] });
    expect(readSelectedId(storage)).toBe('machine-1');
    expect(resolveSelected(parseMachines(storage.getItem(MACHINES_KEY)), readSelectedId(storage))).toEqual(DESKTOP);
  });

  it('is idempotent: a second page load changes nothing', () => {
    const storage = new MemoryStorage();
    seedMachines(storage, DESKTOP, ORIGIN);
    const before = storage.getItem(MACHINES_KEY);
    expect(seedMachines(storage, DESKTOP, ORIGIN)).toBe('unchanged');
    expect(storage.getItem(MACHINES_KEY)).toBe(before);
  });

  it('replaces the token in place when Desktop paired again, keeping the other machines and the order', () => {
    const storage = new MemoryStorage();
    const other = { id: 'other', name: 'Notebook', baseUrl: 'https://notebook.tail1234.ts.net', token: 'tok-other' };
    storage.setItem(MACHINES_KEY, JSON.stringify([other, { ...DESKTOP, token: 'stale' }]));
    storage.setItem(SELECTED_KEY, 'other');

    expect(seedMachines(storage, DESKTOP, ORIGIN)).toBe('updated');
    expect(parseMachines(storage.getItem(MACHINES_KEY))).toEqual([other, DESKTOP]);
    // The user's own selection is respected.
    expect(readSelectedId(storage)).toBe('other');
  });

  it('adds Desktop after the machines the user already has', () => {
    const storage = new MemoryStorage();
    const other = { id: 'other', name: 'Notebook', baseUrl: 'https://notebook.tail1234.ts.net', token: 'tok-other' };
    storage.setItem(MACHINES_KEY, JSON.stringify([other]));
    storage.setItem(SELECTED_KEY, 'other');
    expect(seedMachines(storage, DESKTOP, ORIGIN)).toBe('seeded');
    expect(parseMachines(storage.getItem(MACHINES_KEY))).toEqual([other, DESKTOP]);
    expect(readSelectedId(storage)).toBe('other');
  });

  it('selects Desktop when the saved selection points at a machine that no longer exists', () => {
    const storage = new MemoryStorage();
    storage.setItem(SELECTED_KEY, 'gone');
    seedMachines(storage, DESKTOP, ORIGIN);
    expect(readSelectedId(storage)).toBe('machine-1');
  });

  it('keeps entries it does not understand instead of dropping them', () => {
    const storage = new MemoryStorage();
    storage.setItem(MACHINES_KEY, JSON.stringify([{ weird: true }]));
    seedMachines(storage, DESKTOP, ORIGIN);
    expect(JSON.parse(storage.getItem(MACHINES_KEY) ?? '[]')).toEqual([{ weird: true }, DESKTOP]);
  });

  it('leaves an unreadable saved list alone', () => {
    const storage = new MemoryStorage();
    storage.setItem(MACHINES_KEY, '{ not json');
    expect(seedMachines(storage, DESKTOP, ORIGIN)).toBe('skipped');
    expect(storage.getItem(MACHINES_KEY)).toBe('{ not json');
    expect(storage.getItem(SELECTED_KEY)).toBeNull();

    storage.setItem(MACHINES_KEY, '{"a":1}');
    expect(seedMachines(storage, DESKTOP, ORIGIN)).toBe('skipped');
  });

  it('does nothing before Desktop is paired', () => {
    const storage = new MemoryStorage();
    expect(seedMachines(storage, null, ORIGIN)).toBe('skipped');
    expect(storage.data.size).toBe(0);
  });

  it('never writes the token into a page from another origin', () => {
    const storage = new MemoryStorage();
    expect(seedMachines(storage, DESKTOP, 'https://evil.example')).toBe('skipped');
    expect(seedMachines(storage, DESKTOP, 'http://127.0.0.1:7777')).toBe('skipped');
    expect(storage.data.size).toBe(0);
  });

  it('does not throw when the storage refuses to answer', () => {
    const broken: PwaStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    expect(seedMachines(broken, DESKTOP, ORIGIN)).toBe('skipped');
  });
});

describe('language seed, checked against the PWA', () => {
  it('writes the key the PWA reads its language from', () => {
    expect(PWA_LANGUAGE_KEY).toBe(PWA_OWN_LANGUAGE_KEY);
  });

  it('writes only that key, and only when main handed it a language', () => {
    const storage = new MemoryStorage();
    storage.setItem(PWA_MACHINES_KEY, '[]');
    expect(seedLanguage(storage, 'es')).toBe(true);
    expect([...storage.data.keys()].sort()).toEqual([PWA_MACHINES_KEY, PWA_LANGUAGE_KEY].sort());
    expect(storage.getItem(PWA_LANGUAGE_KEY)).toBe('es');
    expect(storage.getItem(PWA_MACHINES_KEY)).toBe('[]');
  });

  it('leaves a language the user chose inside the PWA alone when there is nothing to hand over', () => {
    const storage = new MemoryStorage();
    storage.setItem(PWA_LANGUAGE_KEY, 'en');
    expect(seedLanguage(storage, null)).toBe(false);
    expect(storage.getItem(PWA_LANGUAGE_KEY)).toBe('en');
  });

  it('does not throw when the storage refuses to answer', () => {
    const broken: PwaStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    expect(seedLanguage(broken, 'pt-BR')).toBe(false);
  });
});
