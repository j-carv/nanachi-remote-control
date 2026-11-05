import { describe, expect, it, vi } from 'vitest';
import { CONTROL_INVOKE_CHANNELS, CONTROL_SYNC_CHANNELS, INVOKE_CHANNELS } from '../src/common/channels.js';
import type { WindowState } from '../src/common/control-api.js';
import { registerControlIpc, type ControlIpcDeps, type ControlIpcMainLike, type ControlIpcSender } from '../src/main/control-ipc.js';
import type { ControlActions } from '../src/main/control-service.js';
import { UntrustedSenderError } from '../src/main/ipc.js';

type Handler = (event: ControlIpcSender, ...args: unknown[]) => unknown;

function fakeIpcMain(): ControlIpcMainLike & {
  handlers: Map<string, Handler>;
  syncListeners: Map<string, (event: ControlIpcSender & { returnValue: unknown }) => void>;
} {
  const handlers = new Map<string, Handler>();
  const syncListeners = new Map<string, (event: ControlIpcSender & { returnValue: unknown }) => void>();
  return {
    handlers,
    syncListeners,
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: (channel) => void handlers.delete(channel),
    on: (channel, listener) => void syncListeners.set(channel, listener),
    removeListener: (channel) => void syncListeners.delete(channel),
  };
}

const OK = { ok: true, value: [] } as const;
const STATE: WindowState = { maximized: false, focused: true };

function fakeActions() {
  const actions = {
    overview: vi.fn(() => Promise.resolve({ ok: true, value: {} } as never)),
    restartDaemon: vi.fn(() => Promise.resolve({ ok: true, value: {} } as never)),
    openSessions: vi.fn(() => Promise.resolve()),
    openDataFolder: vi.fn(() => Promise.resolve()),
    folders: {
      get: vi.fn(() => Promise.resolve({ ok: true, value: {} } as never)),
      pick: vi.fn(() => Promise.resolve(['C:\\A'])),
      save: vi.fn(() => Promise.resolve({ ok: true, value: {} } as never)),
      reveal: vi.fn(() => Promise.resolve()),
    },
    devices: {
      list: vi.fn(() => Promise.resolve(OK)),
      revoke: vi.fn(() => Promise.resolve(OK)),
      pairingCode: vi.fn(() => Promise.resolve({ ok: true, value: { code: '123456', expiresAt: 1 } } as const)),
    },
    accounts: {
      list: vi.fn((_refresh?: boolean) => Promise.resolve(OK)),
      setActive: vi.fn(() => Promise.resolve(OK)),
    },
    tailscale: {
      status: vi.fn(() => Promise.resolve({ state: 'off' } as const)),
      start: vi.fn(() => Promise.resolve({ state: 'starting' } as const)),
      stop: vi.fn(() => Promise.resolve({ state: 'off' } as const)),
      openLogin: vi.fn(() => Promise.resolve()),
    },
    logs: {
      get: vi.fn(() => Promise.resolve({ daemon: [], tailscale: [] })),
      openFolder: vi.fn(() => Promise.resolve()),
    },
    settings: {
      getAutostart: vi.fn(() => Promise.resolve({ value: false, supported: true })),
      setAutostart: vi.fn((value: boolean) => Promise.resolve({ value, supported: true })),
      checkForUpdate: vi.fn(() => Promise.resolve({ status: 'up-to-date', current: '1.0.0' } as const)),
      openUpdate: vi.fn(() => Promise.resolve()),
      uninstall: vi.fn(() => Promise.resolve()),
    },
  };
  return actions;
}

function setup(overrides: Partial<ControlIpcDeps> = {}) {
  const ipcMain = fakeIpcMain();
  const actions = fakeActions();
  const window = {
    minimize: vi.fn(),
    toggleMaximize: vi.fn((): WindowState => ({ maximized: true, focused: true })),
    close: vi.fn(),
    state: vi.fn((): WindowState => STATE),
  };
  const dispose = registerControlIpc({
    ipcMain,
    isOwnSender: (event) => event.senderFrame?.url === 'file:///control/index.html',
    version: '1.2.3',
    window,
    actions: actions as unknown as ControlActions,
    ...overrides,
  });
  return { ipcMain, actions, window, dispose };
}

const CONTROL: ControlIpcSender = { sender: { id: 1 }, senderFrame: { url: 'file:///control/index.html' } };
const PANEL: ControlIpcSender = { sender: { id: 2 }, senderFrame: { url: 'http://127.0.0.1:7780/' } };

function call(ipcMain: ReturnType<typeof fakeIpcMain>, channel: string, event: ControlIpcSender, ...args: unknown[]): unknown {
  const handler = ipcMain.handlers.get(channel);
  if (handler === undefined) throw new Error(`sem handler para ${channel}`);
  return handler(event, ...args);
}

describe('registerControlIpc', () => {
  it('registers exactly the control invoke channels and the sync handshake, and none of the panel channels', () => {
    const { ipcMain } = setup();
    expect([...ipcMain.handlers.keys()].sort()).toEqual(Object.values(CONTROL_INVOKE_CHANNELS).sort());
    expect([...ipcMain.syncListeners.keys()]).toEqual([CONTROL_SYNC_CHANNELS.init]);
    for (const channel of Object.values(INVOKE_CHANNELS)) expect(ipcMain.handlers.has(channel)).toBe(false);
  });

  it('refuses every channel for anyone but the control window, and runs nothing', async () => {
    const { ipcMain, actions, window } = setup();
    const strangers: ControlIpcSender[] = [
      PANEL,
      { sender: { id: 1 }, senderFrame: null },
      { sender: { id: 1 } },
      { sender: { id: 1 }, senderFrame: { url: 'https://evil.example/' } },
    ];
    for (const channel of Object.values(CONTROL_INVOKE_CHANNELS)) {
      for (const stranger of strangers) {
        expect(() => call(ipcMain, channel, stranger, ['C:\\A'], true), channel).toThrow(UntrustedSenderError);
      }
    }
    expect(window.minimize).not.toHaveBeenCalled();
    for (const spy of [actions.overview, actions.openSessions, actions.folders.save, actions.devices.revoke, actions.settings.uninstall]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('answers the sync handshake with the version to the control window only', () => {
    const { ipcMain } = setup();
    const listener = ipcMain.syncListeners.get(CONTROL_SYNC_CHANNELS.init);
    const own = { ...CONTROL, returnValue: undefined as unknown };
    listener?.(own);
    expect(own.returnValue).toEqual({ version: '1.2.3' });
    const stranger = { ...PANEL, returnValue: undefined as unknown };
    listener?.(stranger);
    expect(stranger.returnValue).toBeNull();
  });

  it('drives the window', async () => {
    const { ipcMain, window } = setup();
    await call(ipcMain, CONTROL_INVOKE_CHANNELS.windowMinimize, CONTROL);
    await call(ipcMain, CONTROL_INVOKE_CHANNELS.windowClose, CONTROL);
    expect(await call(ipcMain, CONTROL_INVOKE_CHANNELS.windowToggleMaximize, CONTROL)).toEqual({ maximized: true, focused: true });
    expect(await call(ipcMain, CONTROL_INVOKE_CHANNELS.windowState, CONTROL)).toEqual(STATE);
    expect(window.minimize).toHaveBeenCalledTimes(1);
    expect(window.close).toHaveBeenCalledTimes(1);
    expect(window.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it('routes every action channel to its action', async () => {
    const { ipcMain, actions } = setup();
    const own = (channel: string, ...args: unknown[]): unknown => call(ipcMain, channel, CONTROL, ...args);
    const c = CONTROL_INVOKE_CHANNELS;

    await own(c.overview);
    await own(c.restartDaemon);
    await own(c.openSessions);
    await own(c.openDataFolder);
    await own(c.foldersGet);
    expect(await own(c.foldersPick)).toEqual(['C:\\A']);
    await own(c.foldersSave, ['C:\\A', 'D:\\'], true);
    await own(c.foldersReveal, 'C:\\A');
    await own(c.devicesList);
    await own(c.devicesRevoke, 'device-1');
    await own(c.devicesPairingCode);
    await own(c.accountsList);
    await own(c.accountsList, true);
    await own(c.accountsSetActive, 'claude', 'work');
    await own(c.tailscaleStatus);
    await own(c.tailscaleStart);
    await own(c.tailscaleStop);
    await own(c.tailscaleOpenLogin, 'https://login.tailscale.com/a/x');
    await own(c.logsGet);
    await own(c.logsOpenFolder);
    await own(c.settingsGetAutostart);
    expect(await own(c.settingsSetAutostart, true)).toEqual({ value: true, supported: true });
    await own(c.settingsCheckForUpdate);
    await own(c.settingsOpenUpdate, 'https://github.com/j-carv/nanachi-remote-control/releases');
    await own(c.settingsUninstall);

    expect(actions.overview).toHaveBeenCalledTimes(1);
    expect(actions.restartDaemon).toHaveBeenCalledTimes(1);
    expect(actions.openSessions).toHaveBeenCalledTimes(1);
    expect(actions.openDataFolder).toHaveBeenCalledTimes(1);
    expect(actions.folders.save).toHaveBeenCalledWith(['C:\\A', 'D:\\'], true);
    expect(actions.folders.reveal).toHaveBeenCalledWith('C:\\A');
    expect(actions.devices.revoke).toHaveBeenCalledWith('device-1');
    expect(actions.accounts.list.mock.calls).toEqual([[undefined], [true]]);
    expect(actions.accounts.setActive).toHaveBeenCalledWith('claude', 'work');
    expect(actions.tailscale.openLogin).toHaveBeenCalledWith('https://login.tailscale.com/a/x');
    expect(actions.settings.setAutostart).toHaveBeenCalledWith(true);
    expect(actions.settings.openUpdate).toHaveBeenCalledWith('https://github.com/j-carv/nanachi-remote-control/releases');
    expect(actions.settings.uninstall).toHaveBeenCalledTimes(1);
  });

  it('ignores extra arguments from the page', async () => {
    const { ipcMain, actions } = setup();
    await call(ipcMain, CONTROL_INVOKE_CHANNELS.devicesRevoke, CONTROL, 'device-1', '--evil', { x: 1 });
    expect(actions.devices.revoke).toHaveBeenCalledWith('device-1');
    await call(ipcMain, CONTROL_INVOKE_CHANNELS.foldersSave, CONTROL, ['C:\\A'], false, 'extra');
    expect(actions.folders.save).toHaveBeenCalledWith(['C:\\A'], false);
  });

  it('forwards the count of busy sessions the user confirmed, and drops anything else in that place', async () => {
    const { ipcMain, actions } = setup();
    await call(ipcMain, CONTROL_INVOKE_CHANNELS.foldersSave, CONTROL, ['C:\\A'], true, 2);
    expect(actions.folders.save).toHaveBeenLastCalledWith(['C:\\A'], true, 2);
    // Not a number: it is treated as "not confirmed", never as a confirmation.
    for (const garbage of ['2', true, null, { n: 2 }, [2]]) {
      await call(ipcMain, CONTROL_INVOKE_CHANNELS.foldersSave, CONTROL, ['C:\\A'], true, garbage);
      expect(actions.folders.save).toHaveBeenLastCalledWith(['C:\\A'], true);
    }
  });

  describe('validates what the page sends', () => {
    const invalid = { ok: false, code: 'invalid_input' };

    it.each([
      ['no list', undefined, true],
      ['a string instead of a list', 'C:\\A', true],
      ['a list with a number', ['C:\\A', 3], true],
      ['a list with null', [null], true],
      ['a restart flag that is not a boolean', ['C:\\A'], 'sim'],
      ['no restart flag', ['C:\\A'], undefined],
      ['a list with an object', [{ path: 'C:\\A' }], false],
      ['too many folders', Array.from({ length: 300 }, (_, index) => `C:\\p${index}`), false],
      ['a folder that is absurdly long', [`C:\\${'a'.repeat(5000)}`], false],
    ])('folders.save refuses %s', async (_label, roots, restart) => {
      const { ipcMain, actions } = setup();
      const result = await call(ipcMain, CONTROL_INVOKE_CHANNELS.foldersSave, CONTROL, roots, restart);
      expect(result).toMatchObject(invalid);
      expect(actions.folders.save).not.toHaveBeenCalled();
    });

    it.each([[undefined], [null], [5], [{}], [['x']], [true]])('devices.revoke refuses %j', async (id) => {
      const { ipcMain, actions } = setup();
      expect(await call(ipcMain, CONTROL_INVOKE_CHANNELS.devicesRevoke, CONTROL, id)).toMatchObject(invalid);
      expect(actions.devices.revoke).not.toHaveBeenCalled();
    });

    it.each([[undefined, 'a'], ['a', undefined], [1, 'a'], ['a', {}], [null, null]])('accounts.setActive refuses (%j, %j)', async (agent, account) => {
      const { ipcMain, actions } = setup();
      expect(await call(ipcMain, CONTROL_INVOKE_CHANNELS.accountsSetActive, CONTROL, agent, account)).toMatchObject(invalid);
      expect(actions.accounts.setActive).not.toHaveBeenCalled();
    });

    it('accounts.list takes a boolean refresh or nothing, and anything else means no refresh', async () => {
      const { ipcMain, actions } = setup();
      await call(ipcMain, CONTROL_INVOKE_CHANNELS.accountsList, CONTROL, 'sim');
      await call(ipcMain, CONTROL_INVOKE_CHANNELS.accountsList, CONTROL, 1);
      await call(ipcMain, CONTROL_INVOKE_CHANNELS.accountsList, CONTROL, false);
      expect(actions.accounts.list.mock.calls).toEqual([[undefined], [undefined], [false]]);
    });

    it('methods that return no result reject a bad argument instead of guessing', () => {
      const { ipcMain, actions } = setup();
      for (const bad of [undefined, null, 5, {}, ['C:\\A']]) {
        expect(() => call(ipcMain, CONTROL_INVOKE_CHANNELS.foldersReveal, CONTROL, bad)).toThrow(TypeError);
        expect(() => call(ipcMain, CONTROL_INVOKE_CHANNELS.tailscaleOpenLogin, CONTROL, bad)).toThrow(TypeError);
        expect(() => call(ipcMain, CONTROL_INVOKE_CHANNELS.settingsOpenUpdate, CONTROL, bad)).toThrow(TypeError);
      }
      for (const bad of [undefined, null, 'true', 1, {}, []]) {
        expect(() => call(ipcMain, CONTROL_INVOKE_CHANNELS.settingsSetAutostart, CONTROL, bad)).toThrow(TypeError);
      }
      expect(actions.folders.reveal).not.toHaveBeenCalled();
      expect(actions.tailscale.openLogin).not.toHaveBeenCalled();
      expect(actions.settings.openUpdate).not.toHaveBeenCalled();
      expect(actions.settings.setAutostart).not.toHaveBeenCalled();
    });
  });

  it('turns an unexpected exception of a result-returning action into a message, not a rejected call', async () => {
    const { ipcMain, actions } = setup();
    actions.devices.list.mockRejectedValueOnce(new Error('boom'));
    const result = await call(ipcMain, CONTROL_INVOKE_CHANNELS.devicesList, CONTROL);
    expect(result).toMatchObject({ ok: false, code: 'unknown' });
    expect((result as { message: string }).message).toContain('boom');

    actions.folders.save.mockImplementationOnce(() => {
      throw new Error('síncrono');
    });
    expect(await call(ipcMain, CONTROL_INVOKE_CHANNELS.foldersSave, CONTROL, ['C:\\A'], false)).toMatchObject({ ok: false, code: 'unknown' });
  });

  it('dispose removes everything it registered', () => {
    const { ipcMain, dispose } = setup();
    dispose();
    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.syncListeners.size).toBe(0);
  });
});
