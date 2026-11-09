import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_INVOKE_CHANNELS } from '../src/common/channels.js';
import type { DeviceInfo, DriveInfo } from '../src/common/control-api.js';
import { setLanguage, translate, type Language, type MessageKey, type Params } from '../src/common/i18n/index.js';
import type { DaemonStatus } from '../src/common/types.js';
import { registerControlIpc, type ControlIpcMainLike, type ControlIpcSender } from '../src/main/control-ipc.js';
import { createControlService, type ControlActions, type ControlHost } from '../src/main/control-service.js';
import type { DaemonApi } from '../src/main/daemon-api.js';
import { MAX_ROOT_LENGTH, MAX_ROOTS, type RootsStore } from '../src/main/roots-config.js';

afterEach(() => setLanguage('pt-BR'));

const OTHERS = ['en', 'es'] as const;

function statusOf(patch: Partial<DaemonStatus> = {}): DaemonStatus {
  return { state: 'running', port: 7780, mode: 'spawned', pid: 1, version: '1.0.0', machineName: 'PC', restricted: false, message: null, logTail: [], ...patch };
}

/** A host whose restart ends as the test says: back up, in error, or attached to somebody else's daemon. */
function fakeHost(initial: Partial<DaemonStatus>, afterStart: Partial<DaemonStatus> = {}): ControlHost {
  let status = statusOf(initial);
  return {
    status: () => ({ ...status }),
    onStatus: () => () => undefined,
    stop: () => {
      status = { ...status, state: 'stopped', mode: 'none', pid: null };
      return Promise.resolve();
    },
    start: () => {
      status = { ...status, ...afterStart };
      return Promise.resolve();
    },
  };
}

const THIS_APP: DeviceInfo = { id: 'self', name: 'Nanachi Desktop', createdAt: 1, lastSeenAt: null, revoked: false, isThisApp: true };

function build(host: ControlHost, devices: DeviceInfo[] = []): ControlActions {
  const daemon: DaemonApi = {
    whisper: async () => ({ state: 'disabled' }),
    transcriptionSettings: async () => ({ provider: 'whisper', model: 'ggml-base-q5_1.bin', baseUrl: '', timeoutMs: 90_000, apiKeyConfigured: false }),
    setTranscriptionSettings: async (settings) => ({ provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, timeoutMs: settings.timeoutMs, apiKeyConfigured: Boolean(settings.apiKey) }),
    transcriptionStatus: async () => ({ provider: 'whisper', model: 'ggml-base-q5_1.bin', state: 'not_ready' }),
    transcriptionModels: async () => ({ models: [], manual: false }),
    devices: vi.fn(() => Promise.resolve(devices)),
    revokeDevice: vi.fn(() => Promise.resolve()),
    accounts: vi.fn(() => Promise.resolve([])),
    setActiveAccount: vi.fn(() => Promise.resolve()),
    roots: vi.fn(() => Promise.resolve([])),
    activity: vi.fn(() => Promise.resolve({ workspaces: 0, sessions: 0, busySessions: 0 })),
  };
  const roots: RootsStore = {
    read: () => [],
    save: (input) => Promise.resolve([...input]),
    describe: (list) => Promise.resolve(list.map((path) => ({ path, exists: true, coveredBy: null }))),
    probe: () => Promise.resolve('dir'),
  };
  const drives: DriveInfo[] = [];
  return createControlService({
    home: 'C:\\Users\\user\\.nanachi-desktop',
    appVersion: '1.0.0',
    host,
    daemon,
    roots,
    drives: () => Promise.resolve(drives),
    tailscale: { status: () => ({ state: 'off' }), start: () => Promise.resolve({ state: 'off' }), stop: () => Promise.resolve({ state: 'off' }) },
    pairingCode: () => Promise.resolve({ code: '123456', expiresAt: 1 }),
    language: { set: (next: Language) => next },
    readLogs: () => ({ daemon: [], tailscale: [] }),
    autostart: { supported: true, get: () => false, set: (value) => value },
    checkForUpdate: () => Promise.resolve({ status: 'up-to-date', current: '1.0.0' }),
    system: {
      pickFolders: () => Promise.resolve([]),
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => undefined,
      openExternal: () => Promise.resolve(),
      setSessionsViewport: () => undefined,
      startUninstaller: () => undefined,
    },
    log: () => undefined,
    settleTimeoutMs: 20,
  });
}

const failureOf = (result: unknown): { code: string; message: string } => {
  expect(result).toMatchObject({ ok: false });
  return result as { code: string; message: string };
};

describe.each(OTHERS)('control service messages in %s', (language) => {
  const say = (key: MessageKey, params?: Params): string => translate(language, key, params);

  it('an id that is not an id, a daemon that cannot be asked, a code that cannot be made', async () => {
    setLanguage(language);
    const stopped = build(fakeHost({ state: 'stopped', mode: 'none', pid: null }));
    expect(failureOf(await stopped.devices.revoke('a/b'))).toEqual({ ok: false, code: 'invalid_input', message: say('main.control.invalidId') });
    expect(failureOf(await stopped.accounts.setActive('', 'x'))).toEqual({ ok: false, code: 'invalid_input', message: say('main.control.invalidId') });
    expect(failureOf(await stopped.devices.list())).toEqual({ ok: false, code: 'daemon_unavailable', message: say('main.control.daemonNotAvailable') });
    expect(failureOf(await stopped.accounts.list())).toEqual({ ok: false, code: 'daemon_unavailable', message: say('main.control.daemonNotAvailable') });
    expect(failureOf(await stopped.devices.pairingCode())).toEqual({ ok: false, code: 'daemon_unavailable', message: say('main.control.daemonNotRunning') });
    expect(say('main.control.invalidId')).not.toBe(translate('pt-BR', 'main.control.invalidId'));
  });

  it('refuses to revoke the device Desktop itself uses', async () => {
    setLanguage(language);
    const running = build(fakeHost({}), [THIS_APP]);
    expect(failureOf(await running.devices.revoke('self'))).toEqual({ ok: false, code: 'invalid_input', message: say('main.control.revokeThisApp') });
  });

  it('a daemon Desktop did not start cannot be restarted or have its folders edited', async () => {
    setLanguage(language);
    const attached = build(fakeHost({ state: 'attached', mode: 'attached', pid: null }));
    expect(failureOf(await attached.restartDaemon())).toEqual({ ok: false, code: 'not_own_daemon', message: say('main.control.restartNotOwn') });
    expect(failureOf(await attached.folders.save(['C:\\Projects'], false))).toEqual({ ok: false, code: 'not_own_daemon', message: say('main.control.foldersNotOwn') });
  });

  it('a busy-session confirmation that is not a count is refused', async () => {
    setLanguage(language);
    const running = build(fakeHost({}));
    expect(failureOf(await running.folders.save(['C:\\Projects'], false, -1))).toEqual({ ok: false, code: 'invalid_input', message: say('main.control.invalidBusyConfirmation') });
  });

  it('a restart that ends in another program\'s daemon, or in an error, says so with the status message it was given', async () => {
    setLanguage(language);
    const attached = build(fakeHost({}, { state: 'attached', mode: 'attached', pid: null }));
    expect(failureOf(await attached.restartDaemon())).toEqual({ ok: false, code: 'daemon_unavailable', message: say('main.control.restartAttached') });

    const failed = build(fakeHost({}, { state: 'error', mode: 'none', pid: null, message: 'the host said this' }));
    expect(failureOf(await failed.restartDaemon())).toEqual({
      ok: false,
      code: 'daemon_unavailable',
      message: say('main.control.restartFailedDetail', { detail: 'the host said this' }),
    });

    const silent = build(fakeHost({}, { state: 'error', mode: 'none', pid: null, message: null }));
    expect(failureOf(await silent.restartDaemon())).toEqual({ ok: false, code: 'daemon_unavailable', message: say('main.control.restartFailed') });
  });
});

describe('the Portuguese messages are unchanged', () => {
  it('spot checks', async () => {
    const attached = build(fakeHost({ state: 'attached', mode: 'attached', pid: null }));
    expect(failureOf(await attached.restartDaemon()).message).toBe('O Nanachi está usando um daemon que ele não iniciou, então não pode reiniciá-lo por aqui.');
    expect(failureOf(await attached.devices.revoke('a/b')).message).toBe('Identificador inválido.');
    const failed = build(fakeHost({}, { state: 'error', mode: 'none', pid: null, message: 'A porta 7780 está ocupada.' }));
    expect(failureOf(await failed.restartDaemon()).message).toBe('O daemon foi parado, mas não conseguiu iniciar de novo. A porta 7780 está ocupada. Veja a aba Logs.');
  });
});

type Handler = (event: ControlIpcSender, ...args: unknown[]) => unknown;

function ipcWith(actions: ControlActions): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcMain: ControlIpcMainLike = {
    handle: (channel, listener) => void handlers.set(channel, listener),
    removeHandler: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  };
  registerControlIpc({
    ipcMain,
    isOwnSender: () => true,
    version: '1.0.0',
    language: () => 'pt-BR',
    window: { minimize: () => undefined, toggleMaximize: () => ({ maximized: false, focused: true }), close: () => undefined, state: () => ({ maximized: false, focused: true }) },
    actions,
  });
  return handlers;
}

describe.each(OTHERS)('control IPC refusals in %s', (language) => {
  const own: ControlIpcSender = { sender: { id: 1 }, senderFrame: { url: 'file:///control/index.html' } };
  const say = (key: MessageKey, params?: Params): string => translate(language, key, params);

  it('a folder list that makes no sense, too many folders, a path that is too long', async () => {
    setLanguage(language);
    const handlers = ipcWith(build(fakeHost({})));
    const call = async (channel: string, ...args: unknown[]): Promise<unknown> => {
      const handler = handlers.get(channel);
      if (handler === undefined) throw new Error(`no handler for ${channel}`);
      return handler(own, ...args);
    };
    const save = CONTROL_INVOKE_CHANNELS.foldersSave;
    expect(failureOf(await call(save, 'C:\\A', true))).toEqual({ ok: false, code: 'invalid_input', message: say('main.control.invalidFoldersRequest') });
    expect(failureOf(await call(save, Array.from({ length: MAX_ROOTS + 1 }, (_, index) => `C:\\F${index}`), false))).toEqual({
      ok: false,
      code: 'invalid_input',
      message: say('main.roots.tooMany', { max: MAX_ROOTS }),
    });
    expect(failureOf(await call(save, [`C:\\${'x'.repeat(MAX_ROOT_LENGTH)}`], false))).toEqual({
      ok: false,
      code: 'invalid_input',
      message: say('main.control.oneFolderTooLong'),
    });
    expect(failureOf(await call(CONTROL_INVOKE_CHANNELS.devicesRevoke, 42))).toEqual({ ok: false, code: 'invalid_input', message: say('main.control.invalidId') });
    expect(failureOf(await call(CONTROL_INVOKE_CHANNELS.accountsSetActive, 'agent', 7))).toEqual({ ok: false, code: 'invalid_input', message: say('main.control.invalidId') });
  });
});

describe('the control IPC refusals in pt-BR', () => {
  it('are the texts the app always had', async () => {
    const handlers = ipcWith(build(fakeHost({})));
    const own: ControlIpcSender = { sender: { id: 1 }, senderFrame: { url: 'file:///control/index.html' } };
    const save = handlers.get(CONTROL_INVOKE_CHANNELS.foldersSave);
    expect(failureOf(await save?.(own, 'C:\\A', true)).message).toBe('Pedido inválido: a lista de pastas ou a opção de reiniciar não faz sentido.');
    expect(failureOf(await save?.(own, Array.from({ length: MAX_ROOTS + 1 }, (_, index) => `C:\\F${index}`), false)).message).toBe(`Muitas pastas: o máximo é ${MAX_ROOTS}.`);
  });
});
