import { describe, expect, it, vi } from 'vitest';
import { INVOKE_CHANNELS, SYNC_CHANNELS } from '../src/common/channels.js';
import type { DaemonStatus, PreloadInit } from '../src/common/types.js';
import { registerIpc, UntrustedSenderError, type IpcDeps, type IpcMainLike, type IpcSender } from '../src/main/ipc.js';

const ORIGIN = 'http://127.0.0.1:7811';
const STATUS: DaemonStatus = {
  state: 'running',
  port: 7811,
  mode: 'spawned',
  pid: 10,
  version: '1.0.0',
  machineName: 'PC',
  restricted: false,
  message: null,
  logTail: [],
};

function fakeIpcMain(): IpcMainLike & {
  handlers: Map<string, (event: IpcSender, ...args: unknown[]) => unknown>;
  syncListeners: Map<string, (event: IpcSender & { returnValue: unknown }) => void>;
} {
  const handlers = new Map<string, (event: IpcSender, ...args: unknown[]) => unknown>();
  const syncListeners = new Map<string, (event: IpcSender & { returnValue: unknown }) => void>();
  return {
    handlers,
    syncListeners,
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
    on: (channel, listener) => void syncListeners.set(channel, listener),
    removeListener: (channel) => void syncListeners.delete(channel),
  };
}

function setup(overrides: Partial<IpcDeps> = {}) {
  const ipcMain = fakeIpcMain();
  const setAutostart = vi.fn((value: boolean) => value);
  const init: PreloadInit = { version: '0.1.0', machine: { id: 'm', name: 'PC', baseUrl: ORIGIN, token: 't' } };
  const dispose = registerIpc({
    ipcMain,
    isTrustedUrl: (url) => url === `${ORIGIN}/` || url?.startsWith(`${ORIGIN}/`) === true,
    status: () => STATUS,
    pairingCode: () => Promise.resolve({ code: '123456', expiresAt: 9 }),
    getAutostart: () => true,
    setAutostart,
    tailscale: {
      status: () => ({ state: 'off' }),
      start: () => Promise.resolve({ state: 'starting' }),
      stop: () => Promise.resolve({ state: 'off' }),
    },
    checkForUpdate: () => Promise.resolve({ status: 'up-to-date', current: '0.1.0' }),
    init: () => init,
    ...overrides,
  });
  return { ipcMain, setAutostart, dispose, init };
}

const PANEL: IpcSender = { senderFrame: { url: `${ORIGIN}/settings` } };

describe('registerIpc', () => {
  it('registers exactly the fixed invoke channels and the sync handshake', () => {
    const { ipcMain } = setup();
    expect([...ipcMain.handlers.keys()].sort()).toEqual(Object.values(INVOKE_CHANNELS).sort());
    expect([...ipcMain.syncListeners.keys()]).toEqual([SYNC_CHANNELS.init]);
  });

  it('answers a trusted sender', async () => {
    const { ipcMain } = setup();
    expect(await ipcMain.handlers.get(INVOKE_CHANNELS.status)?.(PANEL)).toEqual(STATUS);
    expect(await ipcMain.handlers.get(INVOKE_CHANNELS.pairingCode)?.(PANEL)).toEqual({ code: '123456', expiresAt: 9 });
    expect(await ipcMain.handlers.get(INVOKE_CHANNELS.getAutostart)?.(PANEL)).toBe(true);
    expect(await ipcMain.handlers.get(INVOKE_CHANNELS.tailscaleStart)?.(PANEL)).toEqual({ state: 'starting' });
    expect(await ipcMain.handlers.get(INVOKE_CHANNELS.checkForUpdate)?.(PANEL)).toEqual({
      status: 'up-to-date',
      current: '0.1.0',
    });
  });

  it.each([
    ['another origin', { senderFrame: { url: 'https://evil.example/' } }],
    ['a different port', { senderFrame: { url: 'http://127.0.0.1:7777/' } }],
    ['no frame', { senderFrame: null }],
    ['no frame info', {}],
  ])('refuses every channel for %s', async (_label, sender) => {
    const { ipcMain, setAutostart } = setup();
    for (const channel of Object.values(INVOKE_CHANNELS)) {
      expect(() => ipcMain.handlers.get(channel)?.(sender as IpcSender, true)).toThrow(UntrustedSenderError);
    }
    expect(setAutostart).not.toHaveBeenCalled();
  });

  it('validates setAutostart input: only a boolean', async () => {
    const { ipcMain, setAutostart } = setup();
    const handler = ipcMain.handlers.get(INVOKE_CHANNELS.setAutostart);
    expect(await handler?.(PANEL, true)).toBe(true);
    expect(await handler?.(PANEL, false)).toBe(false);
    expect(setAutostart).toHaveBeenCalledTimes(2);

    for (const bad of [undefined, null, 'true', 1, {}, []]) {
      expect(() => handler?.(PANEL, bad)).toThrow(TypeError);
    }
    expect(setAutostart).toHaveBeenCalledTimes(2);
  });

  it('ignores extra arguments from the page', async () => {
    const { ipcMain, setAutostart } = setup();
    await ipcMain.handlers.get(INVOKE_CHANNELS.setAutostart)?.(PANEL, true, '--evil', { x: 1 });
    expect(setAutostart).toHaveBeenCalledWith(true);
  });

  it('the preload handshake returns the machine to the panel only, null to a stranger', () => {
    const { ipcMain, init } = setup();
    const listener = ipcMain.syncListeners.get(SYNC_CHANNELS.init);

    const good = { ...PANEL, returnValue: undefined as unknown };
    listener?.(good);
    expect(good.returnValue).toEqual(init);

    const stranger = { senderFrame: { url: 'https://evil.example/' }, returnValue: undefined as unknown };
    listener?.(stranger);
    expect(stranger.returnValue).toBeNull();
  });

  it('dispose removes everything it registered', () => {
    const { ipcMain, dispose } = setup();
    dispose();
    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.syncListeners.size).toBe(0);
  });
});
