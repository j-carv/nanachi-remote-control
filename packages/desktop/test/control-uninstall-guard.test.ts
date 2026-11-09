import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DriveInfo } from '../src/common/control-api.js';
import type { DaemonStatus } from '../src/common/types.js';
import { UNINSTALL_GUARD_MS } from '../src/common/uninstall-guard.js';
import { createControlService, type ControlHost } from '../src/main/control-service.js';
import type { DaemonApi } from '../src/main/daemon-api.js';
import type { RootsStore } from '../src/main/roots-config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const DRIVES: DriveInfo[] = [];

/** A control service whose only interesting part is the uninstaller hook: everything else answers nothing in particular. */
function build(startUninstaller: () => void) {
  const status: DaemonStatus = {
    state: 'running',
    port: 7780,
    mode: 'spawned',
    pid: 1,
    version: '1.0.0',
    machineName: 'PC',
    restricted: false,
    message: null,
    logTail: [],
  };
  const host: ControlHost = {
    status: () => status,
    onStatus: () => () => undefined,
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  const daemon: DaemonApi = {
    whisper: async () => ({ state: 'disabled' }),
    transcriptionSettings: async () => ({ provider: 'whisper', model: 'ggml-base-q5_1.bin', baseUrl: '', timeoutMs: 90_000, apiKeyConfigured: false }),
    setTranscriptionSettings: async (settings) => ({ provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl, timeoutMs: settings.timeoutMs, apiKeyConfigured: Boolean(settings.apiKey) }),
    transcriptionStatus: async () => ({ provider: 'whisper', model: 'ggml-base-q5_1.bin', state: 'not_ready' }),
    transcriptionModels: async () => ({ models: [], manual: false }),
    devices: () => Promise.resolve([]),
    revokeDevice: () => Promise.resolve(),
    accounts: () => Promise.resolve([]),
    setActiveAccount: () => Promise.resolve(),
    roots: () => Promise.resolve([]),
    activity: () => Promise.resolve({ workspaces: 0, sessions: 0, busySessions: 0 }),
  };
  const roots: RootsStore = {
    read: () => [],
    save: (input) => Promise.resolve([...input]),
    describe: (list) => Promise.resolve(list.map((path) => ({ path, exists: true, coveredBy: null }))),
    probe: () => Promise.resolve('dir'),
  };
  return createControlService({
    home: 'C:\\Users\\user\\.nanachi-desktop',
    appVersion: '1.0.0',
    host,
    daemon,
    roots,
    drives: () => Promise.resolve(DRIVES),
    tailscale: { status: () => ({ state: 'off' }), start: () => Promise.resolve({ state: 'off' }), stop: () => Promise.resolve({ state: 'off' }) },
    pairingCode: () => Promise.resolve({ code: '123456', expiresAt: 1 }),
    language: { set: (next) => next },
    readLogs: () => ({ daemon: [], tailscale: [] }),
    autostart: { supported: true, get: () => false, set: (value) => value },
    checkForUpdate: () => Promise.resolve({ status: 'up-to-date', current: '1.0.0' }),
    system: {
      pickFolders: () => Promise.resolve([]),
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => undefined,
      openExternal: () => Promise.resolve(),
      setSessionsViewport: () => undefined,
      startUninstaller,
    },
    log: () => undefined,
    settleTimeoutMs: 20,
  });
}

describe('uninstall requests in Desktop', () => {
  it('a request inside the guard window starts no second uninstaller, and still resolves for the page', async () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const startUninstaller = vi.fn();
    const service = build(startUninstaller);

    await service.settings.uninstall();
    expect(startUninstaller).toHaveBeenCalledTimes(1);

    now += 5_000;
    await expect(service.settings.uninstall()).resolves.toBeUndefined();
    expect(startUninstaller).toHaveBeenCalledTimes(1);
  });

  it('a refused request does not restart the window: the next one is allowed once the first window is over', async () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const startUninstaller = vi.fn();
    const service = build(startUninstaller);

    await service.settings.uninstall();
    now += 5_000;
    await service.settings.uninstall();
    now += UNINSTALL_GUARD_MS - 5_000 - 1;
    await service.settings.uninstall();
    expect(startUninstaller).toHaveBeenCalledTimes(1);

    now += 1;
    await service.settings.uninstall();
    expect(startUninstaller).toHaveBeenCalledTimes(2);
  });
});
