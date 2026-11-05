import { describe, expect, it, vi } from 'vitest';
import type { AgentAccountsInfo, DeviceInfo, DriveInfo, LogsInfo } from '../src/common/control-api.js';
import type { DaemonStatus, TailscaleStatus, UpdateCheckResult } from '../src/common/types.js';
import { createControlService, type ControlHost, type ControlServiceDeps } from '../src/main/control-service.js';
import { DaemonApiError, type DaemonApi } from '../src/main/daemon-api.js';
import { RootsConfigError, type PathKind, type RootsStore } from '../src/main/roots-config.js';

const HOME = 'C:\\Users\\user\\.nanachi-desktop';

function statusOf(patch: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    state: 'running',
    port: 7780,
    mode: 'spawned',
    pid: 1234,
    version: '1.0.0',
    machineName: 'PC',
    restricted: false,
    message: null,
    logTail: [],
    ...patch,
  };
}

function fakeHost(initial: Partial<DaemonStatus> = {}, startSettlesAfterMs: number | null = 5, settlesAs: 'running' | 'error' = 'running') {
  let status = statusOf(initial);
  const listeners = new Set<(status: DaemonStatus) => void>();
  const calls: string[] = [];
  const set = (patch: Partial<DaemonStatus>): void => {
    status = { ...status, ...patch };
    for (const listener of listeners) listener({ ...status });
  };
  const host: ControlHost & { calls: string[]; set(patch: Partial<DaemonStatus>): void } = {
    calls,
    set,
    status: () => ({ ...status }),
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      calls.push('stop');
      set({ state: 'stopped', mode: 'none', pid: null });
      return Promise.resolve();
    },
    start() {
      calls.push('start');
      set({ state: 'starting', mode: 'spawned', pid: 99 });
      if (startSettlesAfterMs !== null) {
        setTimeout(
          () => set(settlesAs === 'running' ? { state: 'running' } : { state: 'error', mode: 'none', pid: null, message: 'A porta 7780 está ocupada por outro programa.' }),
          startSettlesAfterMs,
        );
      }
      return Promise.resolve();
    },
  };
  return host;
}

function fakeDaemon(overrides: Partial<DaemonApi> = {}) {
  const api = {
    devices: vi.fn((): Promise<DeviceInfo[]> => Promise.resolve([])),
    revokeDevice: vi.fn((): Promise<void> => Promise.resolve()),
    accounts: vi.fn((): Promise<AgentAccountsInfo[]> => Promise.resolve([])),
    setActiveAccount: vi.fn((): Promise<void> => Promise.resolve()),
    roots: vi.fn((): Promise<string[]> => Promise.resolve([])),
    activity: vi.fn(() => Promise.resolve({ workspaces: 0, sessions: 0, busySessions: 0 })),
    ...overrides,
  };
  return api;
}

function fakeRoots(initial: string[] = [], kinds: Record<string, PathKind> = {}) {
  let saved = [...initial];
  // Windows paths ignore case.
  const byKey = new Map(Object.entries(kinds).map(([path, kind]) => [path.toLowerCase(), kind]));
  const kindOf = (path: string): PathKind => byKey.get(path.toLowerCase()) ?? 'missing';
  const store: RootsStore & { saves: string[][] } = {
    saves: [],
    read: () => [...saved],
    save: (input) => {
      if (input.some((path) => path.includes('RUIM'))) return Promise.reject(new RootsConfigError('invalid_input', 'A pasta "RUIM" não existe.'));
      store.saves.push([...input]);
      saved = [...input];
      return Promise.resolve([...saved]);
    },
    describe: (roots) => Promise.resolve(roots.map((path) => ({ path, exists: kindOf(path) === 'dir', coveredBy: null }))),
    probe: (path) => Promise.resolve(kindOf(path)),
  };
  return store;
}

const DRIVES: DriveInfo[] = [{ root: 'C:\\', label: null, kind: 'fixed', totalBytes: 100, freeBytes: 40 }];
const OFF: TailscaleStatus = { state: 'off' };

function setup(
  options: {
    host?: ReturnType<typeof fakeHost>;
    daemon?: ReturnType<typeof fakeDaemon>;
    roots?: ReturnType<typeof fakeRoots>;
    overrides?: Partial<ControlServiceDeps>;
  } = {},
) {
  const host = options.host ?? fakeHost();
  const daemon = options.daemon ?? fakeDaemon();
  const roots = options.roots ?? fakeRoots();
  const log = vi.fn();
  const system = {
    pickFolders: vi.fn((): Promise<string[]> => Promise.resolve([])),
    openPath: vi.fn((_path: string): Promise<string> => Promise.resolve('')),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn((): Promise<void> => Promise.resolve()),
    openSessions: vi.fn(),
    startUninstaller: vi.fn(),
  };
  const tailscale = {
    status: vi.fn((): TailscaleStatus => OFF),
    start: vi.fn((): Promise<TailscaleStatus> => Promise.resolve({ state: 'starting' })),
    stop: vi.fn((): Promise<TailscaleStatus> => Promise.resolve(OFF)),
  };
  const autostart = { supported: true, get: vi.fn(() => false), set: vi.fn((value: boolean) => value) };
  const checkForUpdate = vi.fn((): Promise<UpdateCheckResult> => Promise.resolve({ status: 'up-to-date', current: '1.0.0' }));
  const logs: LogsInfo = { daemon: ['a'], tailscale: ['[tsnet] b'] };
  const pairingCode = vi.fn(() => Promise.resolve({ code: '123456', expiresAt: 99 }));
  const service = createControlService({
    home: HOME,
    appVersion: '1.0.0',
    host,
    daemon,
    roots,
    drives: () => Promise.resolve(DRIVES),
    tailscale,
    pairingCode,
    readLogs: () => logs,
    autostart,
    checkForUpdate,
    system,
    log,
    settleTimeoutMs: 200,
    ...options.overrides,
  });
  return { service, host, daemon, roots, system, tailscale, autostart, checkForUpdate, pairingCode, log, logs };
}

function expectFailure(result: object, code: string): void {
  expect(result).toMatchObject({ ok: false, code });
  expect((result as { message: string }).message.length).toBeGreaterThan(10);
}

describe('overview', () => {
  it('puts the daemon, Tailscale, activity, data folder and version together', async () => {
    const daemon = fakeDaemon({
      activity: vi.fn(() => Promise.resolve({ workspaces: 2, sessions: 5, busySessions: 1 })),
      devices: vi.fn(() => Promise.resolve([{ id: 'a', name: 'x', createdAt: 1, lastSeenAt: null, revoked: false, isThisApp: true }])),
    });
    const { service } = setup({ daemon });
    const result = await service.overview();
    expect(result).toEqual({
      ok: true,
      value: {
        daemon: statusOf(),
        tailscale: OFF,
        activity: { workspaces: 2, sessions: 5, busySessions: 1, devices: 1 },
        dataFolder: HOME,
        appVersion: '1.0.0',
      },
    });
  });

  it.each([
    ['stopped', { state: 'stopped', mode: 'none' } as const],
    ['starting', { state: 'starting' } as const],
    ['error', { state: 'error', mode: 'none' } as const],
    ['restricted', { restricted: true } as const],
  ])('has no activity, and asks the daemon nothing, when it is %s', async (_label, patch) => {
    const daemon = fakeDaemon();
    const { service } = setup({ host: fakeHost(patch), daemon });
    const result = await service.overview();
    expect(result).toMatchObject({ ok: true, value: { activity: null } });
    expect(daemon.activity).not.toHaveBeenCalled();
    expect(daemon.devices).not.toHaveBeenCalled();
  });

  it('reports the daemon and Tailscale as they are when the answer is ready, not as they were when it started', async () => {
    const host = fakeHost();
    const tailscaleStatus: TailscaleStatus[] = [OFF];
    const daemon = fakeDaemon({
      activity: vi.fn(() => {
        // The daemon dies while the activity is being read.
        host.set({ state: 'stopped', mode: 'none', pid: null });
        tailscaleStatus[0] = { state: 'starting' };
        return Promise.resolve({ workspaces: 1, sessions: 1, busySessions: 0 });
      }),
    });
    const { service, tailscale } = setup({ host, daemon });
    tailscale.status.mockImplementation(() => tailscaleStatus[0] ?? OFF);
    expect(await service.overview()).toMatchObject({ ok: true, value: { daemon: { state: 'stopped' }, tailscale: { state: 'starting' } } });
  });

  it('still answers, with no activity, when the daemon cannot be asked', async () => {
    const daemon = fakeDaemon({ activity: vi.fn(() => Promise.reject(new DaemonApiError('unavailable', 'x'))) });
    const { service } = setup({ daemon });
    expect(await service.overview()).toMatchObject({ ok: true, value: { activity: null, dataFolder: HOME } });
  });
});

describe('folders.get', () => {
  const kinds: Record<string, PathKind> = { 'C:\\A': 'dir', 'D:\\': 'dir' };

  it('shows the saved folders, the drives and the state of the daemon', async () => {
    const { service } = setup({
      roots: fakeRoots(['C:\\A', 'D:\\'], kinds),
      daemon: fakeDaemon({ roots: vi.fn(() => Promise.resolve(['C:\\A', 'D:\\'])) }),
    });
    expect(await service.folders.get()).toEqual({
      ok: true,
      value: {
        roots: [
          { path: 'C:\\A', exists: true, coveredBy: null },
          { path: 'D:\\', exists: true, coveredBy: null },
        ],
        drives: DRIVES,
        editable: true,
        rootsUnknown: false,
        restartPending: false,
        busySessions: 0,
      },
    });
  });

  it('reports a restart pending when the saved folders differ from what the running daemon uses', async () => {
    const { service } = setup({
      roots: fakeRoots(['C:\\A', 'D:\\'], kinds),
      daemon: fakeDaemon({ roots: vi.fn(() => Promise.resolve(['c:\\a'])) }),
    });
    expect(await service.folders.get()).toMatchObject({ ok: true, value: { restartPending: true } });
  });

  it('compares the lists as sets, ignoring case, order and the trailing backslash', async () => {
    const { service } = setup({
      roots: fakeRoots(['C:\\A', 'D:\\'], kinds),
      daemon: fakeDaemon({ roots: vi.fn(() => Promise.resolve(['d:\\', 'c:\\a\\'])) }),
    });
    expect(await service.folders.get()).toMatchObject({ ok: true, value: { restartPending: false } });
  });

  it('counts the sessions a restart would interrupt', async () => {
    const { service } = setup({
      roots: fakeRoots([], kinds),
      daemon: fakeDaemon({ activity: vi.fn(() => Promise.resolve({ workspaces: 1, sessions: 4, busySessions: 3 })) }),
    });
    expect(await service.folders.get()).toMatchObject({ ok: true, value: { busySessions: 3 } });
  });

  it('cannot tell about a daemon that is not answering: nothing pending, nothing busy', async () => {
    const daemon = fakeDaemon();
    const { service } = setup({ host: fakeHost({ state: 'starting' }), roots: fakeRoots(['C:\\A'], kinds), daemon });
    expect(await service.folders.get()).toMatchObject({ ok: true, value: { restartPending: false, busySessions: 0, editable: true } });
    expect(daemon.roots).not.toHaveBeenCalled();
  });

  it('is read-only for a daemon Desktop did not start, and shows the folders that daemon uses', async () => {
    const { service } = setup({
      host: fakeHost({ state: 'attached', mode: 'attached', pid: null }),
      roots: fakeRoots(['C:\\Minha'], { 'C:\\Minha': 'dir', 'E:\\Dela': 'dir' }),
      daemon: fakeDaemon({ roots: vi.fn(() => Promise.resolve(['E:\\Dela'])) }),
    });
    const result = await service.folders.get();
    expect(result).toMatchObject({ ok: true, value: { editable: false, restartPending: false } });
    expect(result.ok && result.value.roots.map((entry) => entry.path)).toEqual(['E:\\Dela']);
  });

  it('does not pass the saved list off as the attached daemon list: an unreadable one is unknown, and empty', async () => {
    const { service } = setup({
      host: fakeHost({ state: 'attached', mode: 'attached', pid: null }),
      roots: fakeRoots(['C:\\Minha'], { 'C:\\Minha': 'dir' }),
      daemon: fakeDaemon({ roots: vi.fn(() => Promise.reject(new DaemonApiError('not_paired', 'x'))) }),
    });
    const result = await service.folders.get();
    expect(result).toMatchObject({ ok: true, value: { editable: false, rootsUnknown: true, roots: [], restartPending: false } });
  });

  it('knows the list of a daemon it owns (or none runs): never flags it as unknown', async () => {
    const { service } = setup({ roots: fakeRoots(['C:\\A'], kinds) });
    expect(await service.folders.get()).toMatchObject({ ok: true, value: { rootsUnknown: false } });
  });

  it('is editable while nothing runs (the config is read at the next start)', async () => {
    const { service } = setup({ host: fakeHost({ state: 'stopped', mode: 'none', pid: null }), roots: fakeRoots(['C:\\A'], kinds) });
    expect(await service.folders.get()).toMatchObject({ ok: true, value: { editable: true, restartPending: false } });
  });

  it('turns an unreadable config into an io error', async () => {
    const roots = fakeRoots();
    roots.read = () => {
      throw new RootsConfigError('io', 'O config.json não é um JSON válido.');
    };
    const { service } = setup({ roots });
    expect(await service.folders.get()).toEqual({ ok: false, code: 'io', message: 'O config.json não é um JSON válido.' });
  });
});

describe('folders.save', () => {
  it('saves and restarts a daemon Desktop owns, in that order, when asked to', async () => {
    const host = fakeHost();
    const roots = fakeRoots(['C:\\Velha'], { 'C:\\A': 'dir' });
    const { service } = setup({ host, roots, daemon: fakeDaemon({ roots: vi.fn(() => Promise.resolve(['C:\\A'])) }) });
    const result = await service.folders.save(['C:\\A'], true);
    expect(roots.saves).toEqual([['C:\\A']]);
    expect(host.calls).toEqual(['stop', 'start']);
    expect(result).toMatchObject({ ok: true, value: { applied: 'restarted', state: { restartPending: false } } });
  });

  it('waits for the new daemon to answer before it reports the state', async () => {
    const host = fakeHost({}, 30);
    const { service } = setup({ host, roots: fakeRoots([], { 'C:\\A': 'dir' }) });
    await service.folders.save(['C:\\A'], true);
    expect(host.status().state).toBe('running');
  });

  it('gives up waiting after the settle timeout and says the daemon is still starting, not that it restarted', async () => {
    const host = fakeHost({}, null);
    const { service } = setup({ host, roots: fakeRoots([], { 'C:\\A': 'dir' }), overrides: { settleTimeoutMs: 20 } });
    const result = await service.folders.save(['C:\\A'], true);
    expect(result).toMatchObject({ ok: true, value: { applied: 'starting' } });
    expect(host.status().state).toBe('starting');
  });

  it('saves without restarting when not asked to, leaving the restart pending', async () => {
    const host = fakeHost();
    const roots = fakeRoots(['C:\\Velha'], { 'C:\\A': 'dir' });
    const { service } = setup({ host, roots, daemon: fakeDaemon({ roots: vi.fn(() => Promise.resolve(['C:\\Velha'])) }) });
    const result = await service.folders.save(['C:\\A'], false);
    expect(host.calls).toEqual([]);
    expect(result).toMatchObject({ ok: true, value: { applied: 'pending', state: { restartPending: true } } });
  });

  it('never restarts when no daemon of its own is running, even when asked to', async () => {
    const host = fakeHost({ state: 'stopped', mode: 'none', pid: null });
    const { service } = setup({ host, roots: fakeRoots([], { 'C:\\A': 'dir' }) });
    const result = await service.folders.save(['C:\\A'], true);
    expect(host.calls).toEqual([]);
    expect(result).toMatchObject({ ok: true, value: { applied: 'pending' } });
  });

  it('refuses to touch the list of a daemon Desktop did not start, and writes nothing', async () => {
    const host = fakeHost({ state: 'attached', mode: 'attached', pid: null });
    const roots = fakeRoots(['C:\\A'], { 'C:\\A': 'dir' });
    const { service } = setup({ host, roots });
    const result = await service.folders.save(['C:\\A'], true);
    expectFailure(result, 'not_own_daemon');
    expect(roots.saves).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it('reports a bad path as invalid input, and neither writes nor restarts', async () => {
    const host = fakeHost();
    const roots = fakeRoots(['C:\\A'], { 'C:\\A': 'dir' });
    const { service } = setup({ host, roots });
    const result = await service.folders.save(['C:\\A', 'D:\\RUIM'], true);
    expect(result).toEqual({ ok: false, code: 'invalid_input', message: 'A pasta "RUIM" não existe.' });
    expect(roots.saves).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it('reports a daemon that did not come back, with the list saved: restart_failed', async () => {
    const host = fakeHost({}, 5, 'error');
    const roots = fakeRoots([], { 'C:\\A': 'dir' });
    const { service } = setup({ host, roots });
    const result = await service.folders.save(['C:\\A'], true);
    expect(roots.saves).toEqual([['C:\\A']]);
    expect(result).toMatchObject({ ok: true, value: { applied: 'restart_failed' } });
  });

  it('does not call it restarted when a foreign daemon took the port meanwhile', async () => {
    const host = fakeHost();
    host.start = () => {
      host.calls.push('start');
      host.set({ state: 'attached', mode: 'attached', pid: null });
      return Promise.resolve();
    };
    const { service } = setup({ host, roots: fakeRoots([], { 'C:\\A': 'dir' }) });
    expect(await service.folders.save(['C:\\A'], true)).toMatchObject({ ok: true, value: { applied: 'restart_failed' } });
  });

  describe('sessions that are busy right now', () => {
    const busy = (count: number) => fakeDaemon({ activity: vi.fn(() => Promise.resolve({ workspaces: 1, sessions: count + 1, busySessions: count })) });

    it('asks for confirmation instead of restarting, writing nothing, and reports the count it just read', async () => {
      const host = fakeHost();
      const roots = fakeRoots(['C:\\Velha'], { 'C:\\A': 'dir' });
      const { service } = setup({ host, roots, daemon: busy(2) });
      const result = await service.folders.save(['C:\\A'], true);
      expect(result).toMatchObject({ ok: true, value: { applied: 'needs_confirmation', state: { busySessions: 2 } } });
      expect(roots.saves).toEqual([]);
      expect(host.calls).toEqual([]);
    });

    it('restarts once the caller confirms interrupting at least that many', async () => {
      const host = fakeHost();
      const roots = fakeRoots(['C:\\Velha'], { 'C:\\A': 'dir' });
      const { service } = setup({ host, roots, daemon: busy(2) });
      expect(await service.folders.save(['C:\\A'], true, 2)).toMatchObject({ ok: true, value: { applied: 'restarted' } });
      expect(host.calls).toEqual(['stop', 'start']);
    });

    it('asks again when more sessions became busy than the user agreed to interrupt', async () => {
      const host = fakeHost();
      const roots = fakeRoots(['C:\\Velha'], { 'C:\\A': 'dir' });
      const { service } = setup({ host, roots, daemon: busy(3) });
      expect(await service.folders.save(['C:\\A'], true, 2)).toMatchObject({ ok: true, value: { applied: 'needs_confirmation', state: { busySessions: 3 } } });
      expect(roots.saves).toEqual([]);
      expect(host.calls).toEqual([]);
    });

    it('does not ask when nothing is busy any more, whatever the screen showed before', async () => {
      const host = fakeHost();
      const { service } = setup({ host, roots: fakeRoots([], { 'C:\\A': 'dir' }), daemon: busy(0) });
      expect(await service.folders.save(['C:\\A'], true)).toMatchObject({ ok: true, value: { applied: 'restarted' } });
    });

    it('does not ask for a save that leaves the restart for later', async () => {
      const host = fakeHost();
      const roots = fakeRoots([], { 'C:\\A': 'dir' });
      const { service } = setup({ host, roots, daemon: busy(4) });
      expect(await service.folders.save(['C:\\A'], false)).toMatchObject({ ok: true, value: { applied: 'pending' } });
      expect(roots.saves).toEqual([['C:\\A']]);
    });

    it('goes ahead when the daemon cannot say what is busy (it could not be asked at all)', async () => {
      const host = fakeHost();
      const daemon = fakeDaemon({ activity: vi.fn(() => Promise.reject(new DaemonApiError('not_paired', 'x'))) });
      const { service } = setup({ host, roots: fakeRoots([], { 'C:\\A': 'dir' }), daemon });
      expect(await service.folders.save(['C:\\A'], true)).toMatchObject({ ok: true, value: { applied: 'restarted' } });
    });

    it('refuses a confirmation that is not a count', async () => {
      const { service } = setup({ roots: fakeRoots([], { 'C:\\A': 'dir' }) });
      for (const bad of [-1, 1.5, Number.NaN, '2' as never]) {
        expectFailure(await service.folders.save(['C:\\A'], true, bad), 'invalid_input');
      }
    });
  });

  it('runs two saves one after the other, never together', async () => {
    const order: string[] = [];
    const roots = fakeRoots([], { 'C:\\A': 'dir', 'C:\\B': 'dir' });
    const originalSave = roots.save;
    roots.save = (input) => {
      order.push(`save:${input.join(',')}`);
      return originalSave(input);
    };
    const host = fakeHost({}, 20);
    const { service } = setup({ host, roots });
    const first = service.folders.save(['C:\\A'], true);
    const second = service.folders.save(['C:\\B'], true);
    await Promise.all([first, second]);
    expect(order).toEqual(['save:C:\\A', 'save:C:\\B']);
    expect(host.calls).toEqual(['stop', 'start', 'stop', 'start']);
  });
});

describe('restartDaemon', () => {
  it('stops and starts the daemon Desktop owns and returns the new status', async () => {
    const host = fakeHost();
    const { service } = setup({ host });
    const result = await service.restartDaemon();
    expect(host.calls).toEqual(['stop', 'start']);
    expect(result).toMatchObject({ ok: true, value: { state: 'running' } });
  });

  it('also starts again when nothing runs (error or stopped), as a way to try again', async () => {
    const host = fakeHost({ state: 'error', mode: 'none', pid: null });
    const { service } = setup({ host });
    await service.restartDaemon();
    expect(host.calls).toEqual(['stop', 'start']);
  });

  it('refuses to restart a daemon it did not start', async () => {
    const host = fakeHost({ state: 'attached', mode: 'attached', pid: null });
    const { service } = setup({ host });
    expectFailure(await service.restartDaemon(), 'not_own_daemon');
    expect(host.calls).toEqual([]);
  });

  it('runs one restart for callers that arrive while it is pending, and gives all of them its answer', async () => {
    const host = fakeHost({}, 20);
    const { service } = setup({ host });
    const results = await Promise.all([service.restartDaemon(), service.restartDaemon(), service.restartDaemon()]);
    expect(host.calls).toEqual(['stop', 'start']);
    for (const result of results) expect(result).toMatchObject({ ok: true, value: { state: 'running' } });
    // Once it is over, a new request restarts again.
    await service.restartDaemon();
    expect(host.calls).toEqual(['stop', 'start', 'stop', 'start']);
  });

  it('is an error, with the daemon message, when the new daemon ends in error', async () => {
    const host = fakeHost({}, 5, 'error');
    const { service } = setup({ host });
    const result = await service.restartDaemon();
    expectFailure(result, 'daemon_unavailable');
    expect((result as { message: string }).message).toContain('porta 7780');
  });

  it('answers with the status as it is (starting) when the wait ends before the daemon is up', async () => {
    const host = fakeHost({}, null);
    const { service } = setup({ host, overrides: { settleTimeoutMs: 20 } });
    expect(await service.restartDaemon()).toMatchObject({ ok: true, value: { state: 'starting' } });
  });
});

describe('devices', () => {
  const me: DeviceInfo = { id: 'me', name: 'Nanachi Desktop (PC)', createdAt: 1, lastSeenAt: 2, revoked: false, isThisApp: true };
  const phone: DeviceInfo = { id: 'phone', name: 'iPhone', createdAt: 1, lastSeenAt: null, revoked: false, isThisApp: false };

  it('lists the devices of the daemon', async () => {
    const { service } = setup({ daemon: fakeDaemon({ devices: vi.fn(() => Promise.resolve([me, phone])) }) });
    expect(await service.devices.list()).toEqual({ ok: true, value: [me, phone] });
  });

  it('revokes a phone and returns the list as it is afterwards', async () => {
    const devices = vi.fn().mockResolvedValueOnce([me, phone]).mockResolvedValueOnce([me]);
    const daemon = fakeDaemon({ devices });
    const { service } = setup({ daemon });
    expect(await service.devices.revoke('phone')).toEqual({ ok: true, value: [me] });
    expect(daemon.revokeDevice).toHaveBeenCalledWith('phone');
  });

  it('refuses to revoke the device Desktop itself uses', async () => {
    const daemon = fakeDaemon({ devices: vi.fn(() => Promise.resolve([me, phone])) });
    const { service } = setup({ daemon });
    expectFailure(await service.devices.revoke('me'), 'invalid_input');
    expect(daemon.revokeDevice).not.toHaveBeenCalled();
  });

  it('treats a device that is already gone as done', async () => {
    const daemon = fakeDaemon({ devices: vi.fn(() => Promise.resolve([me])) });
    const { service } = setup({ daemon });
    expect(await service.devices.revoke('ghost')).toEqual({ ok: true, value: [me] });
    expect(daemon.revokeDevice).not.toHaveBeenCalled();
  });

  it('treats a 404 from the daemon (revoked meanwhile) as done', async () => {
    const devices = vi.fn().mockResolvedValueOnce([me, phone]).mockResolvedValueOnce([me]);
    const daemon = fakeDaemon({ devices, revokeDevice: vi.fn(() => Promise.reject(new DaemonApiError('not_found', 'x', 404))) });
    const { service } = setup({ daemon });
    expect(await service.devices.revoke('phone')).toEqual({ ok: true, value: [me] });
  });

  it.each([[''], ['a/b'], ['a\\b'], ['a\nb'], ['x'.repeat(129)]])('refuses the id %j', async (id) => {
    const daemon = fakeDaemon();
    const { service } = setup({ daemon });
    expectFailure(await service.devices.revoke(id), 'invalid_input');
    expect(daemon.devices).not.toHaveBeenCalled();
  });

  it('generates a pairing code only while a daemon answers', async () => {
    const { service, pairingCode } = setup();
    expect(await service.devices.pairingCode()).toEqual({ ok: true, value: { code: '123456', expiresAt: 99 } });
    expect(pairingCode).toHaveBeenCalledTimes(1);

    const stopped = setup({ host: fakeHost({ state: 'stopped', mode: 'none', pid: null }) });
    expectFailure(await stopped.service.devices.pairingCode(), 'daemon_unavailable');
    expect(stopped.pairingCode).not.toHaveBeenCalled();
  });

  it('turns a failing pairing command into a message', async () => {
    const { service } = setup({ overrides: { pairingCode: () => Promise.reject(new Error('o comando saiu com código 1')) } });
    const result = await service.devices.pairingCode();
    expectFailure(result, 'unknown');
    expect((result as { message: string }).message).toContain('código 1');
  });

  it('maps daemon failures to messages instead of throwing', async () => {
    const daemon = fakeDaemon({ devices: vi.fn(() => Promise.reject(new DaemonApiError('unavailable', 'x'))) });
    const { service } = setup({ daemon });
    expectFailure(await service.devices.list(), 'daemon_unavailable');
  });

  it.each([
    ['stopped', { state: 'stopped', mode: 'none', pid: null } as const],
    ['starting', { state: 'starting' } as const],
    ['in error', { state: 'error', mode: 'none', pid: null } as const],
    ['restricted to Tailscale', { restricted: true } as const],
  ])('asks the daemon nothing, not even to pair, while it is %s', async (_label, patch) => {
    const daemon = fakeDaemon();
    const { service } = setup({ host: fakeHost(patch), daemon });
    expectFailure(await service.devices.list(), 'daemon_unavailable');
    expectFailure(await service.devices.revoke('phone'), 'daemon_unavailable');
    expectFailure(await service.accounts.list(), 'daemon_unavailable');
    expectFailure(await service.accounts.setActive('claude', 'work'), 'daemon_unavailable');
    for (const call of [daemon.devices, daemon.revokeDevice, daemon.accounts, daemon.setActiveAccount]) expect(call).not.toHaveBeenCalled();
  });
});

describe('accounts', () => {
  const claude: AgentAccountsInfo = {
    agentId: 'claude',
    agentName: 'Claude Code',
    multiAccount: true,
    accounts: [{ id: 'default', name: 'Principal', principal: true, active: true, status: 'logged_in', identity: 'eu@exemplo.com' }],
  };

  it('lists from the daemon cache, or refreshes when asked', async () => {
    const daemon = fakeDaemon({ accounts: vi.fn(() => Promise.resolve([claude])) });
    const { service } = setup({ daemon });
    expect(await service.accounts.list()).toEqual({ ok: true, value: [claude] });
    await service.accounts.list(true);
    expect(vi.mocked(daemon.accounts).mock.calls).toEqual([[false], [true]]);
  });

  it('sets the active account and returns the list afterwards', async () => {
    const daemon = fakeDaemon({ accounts: vi.fn(() => Promise.resolve([claude])) });
    const { service } = setup({ daemon });
    expect(await service.accounts.setActive('claude', 'work')).toEqual({ ok: true, value: [claude] });
    expect(daemon.setActiveAccount).toHaveBeenCalledWith('claude', 'work');
  });

  it('explains a refusal from the daemon', async () => {
    const daemon = fakeDaemon({ setActiveAccount: vi.fn(() => Promise.reject(new DaemonApiError('rejected', 'x', 400, 'accounts_unsupported'))) });
    const { service } = setup({ daemon });
    const result = await service.accounts.setActive('omp', 'default');
    expectFailure(result, 'invalid_input');
    expect((result as { message: string }).message).toMatch(/contas extras/);
  });

  it('refuses ids that are not plain identifiers', async () => {
    const daemon = fakeDaemon();
    const { service } = setup({ daemon });
    expectFailure(await service.accounts.setActive('', 'work'), 'invalid_input');
    expectFailure(await service.accounts.setActive('claude', '../x'), 'invalid_input');
    expect(daemon.setActiveAccount).not.toHaveBeenCalled();
  });
});

describe('tailscale', () => {
  it('passes status, start and stop through', async () => {
    const { service, tailscale } = setup();
    expect(await service.tailscale.status()).toEqual(OFF);
    expect(await service.tailscale.start()).toEqual({ state: 'starting' });
    expect(await service.tailscale.stop()).toEqual(OFF);
    expect(tailscale.start).toHaveBeenCalledTimes(1);
    expect(tailscale.stop).toHaveBeenCalledTimes(1);
  });

  it('opens the login page Tailscale itself is asking for, normalized, and nothing else', async () => {
    const { service, system, tailscale } = setup();
    tailscale.status.mockReturnValue({ state: 'needs_login', authUrl: 'https://login.tailscale.com/a/abc' });
    await service.tailscale.openLogin('https://LOGIN.tailscale.com/a/abc');
    expect(system.openExternal).toHaveBeenCalledWith('https://login.tailscale.com/a/abc');
    for (const bad of [
      // Another page of the login host: the page may only repeat the address main already holds.
      'https://login.tailscale.com/a/outra',
      'https://evil.example/a',
      'http://login.tailscale.com/a/abc',
      'file:///C:/x.exe',
      'javascript:alert(1)',
      '',
    ]) {
      await expect(service.tailscale.openLogin(bad)).rejects.toThrow(TypeError);
    }
    expect(system.openExternal).toHaveBeenCalledTimes(1);
  });

  it('opens nothing when Tailscale is not asking for a login, whatever address the page sends', async () => {
    const { service, system, tailscale } = setup();
    for (const status of [OFF, { state: 'starting' } as const, { state: 'error', message: 'x' } as const]) {
      tailscale.status.mockReturnValue(status);
      await expect(service.tailscale.openLogin('https://login.tailscale.com/a/abc')).rejects.toThrow(TypeError);
    }
    expect(system.openExternal).not.toHaveBeenCalled();
  });

  it('refuses a login address that main itself got and does not trust', async () => {
    const { service, system, tailscale } = setup();
    tailscale.status.mockReturnValue({ state: 'needs_login', authUrl: 'https://evil.example/a/abc' });
    await expect(service.tailscale.openLogin('https://evil.example/a/abc')).rejects.toThrow(TypeError);
    expect(system.openExternal).not.toHaveBeenCalled();
  });
});

describe('logs, folders in the Explorer, settings', () => {
  it('reads the logs and opens the data folder', async () => {
    const { service, system, logs } = setup();
    expect(await service.logs.get()).toEqual(logs);
    await service.logs.openFolder();
    await service.openDataFolder();
    expect(system.openPath).toHaveBeenNthCalledWith(1, HOME);
    expect(system.openPath).toHaveBeenNthCalledWith(2, HOME);
  });

  it('only logs when the shell could not open the folder', async () => {
    const { service, system, log } = setup();
    system.openPath.mockResolvedValue('O sistema não pôde abrir a pasta');
    await expect(service.openDataFolder()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('não pôde abrir'));
  });

  it('opens sessions through the system hook', async () => {
    const { service, system } = setup();
    await service.openSessions();
    expect(system.openSessions).toHaveBeenCalledTimes(1);
  });

  it('shows the picker folders normalized and without duplicates or junk', async () => {
    const { service, system } = setup();
    system.pickFolders.mockResolvedValue(['c:/projetos/', 'C:\\Projetos', 'relativo', 'D:\\']);
    expect(await service.folders.pick()).toEqual(['C:\\projetos', 'D:\\']);
  });

  it('reveals a folder by opening it, and anything else by showing it in its parent (never by opening a file)', async () => {
    const kinds: Record<string, PathKind> = { 'C:\\Pasta': 'dir', 'C:\\arquivo.exe': 'file' };
    const { service, system } = setup({ roots: fakeRoots(['C:\\Pasta', 'C:\\arquivo.exe', 'C:\\Sumiu'], kinds) });
    await service.folders.reveal('C:\\Pasta\\');
    expect(system.openPath).toHaveBeenCalledWith('C:\\Pasta');
    expect(system.showItemInFolder).not.toHaveBeenCalled();

    await service.folders.reveal('C:\\arquivo.exe');
    await service.folders.reveal('C:\\Sumiu');
    expect(system.showItemInFolder.mock.calls).toEqual([['C:\\arquivo.exe'], ['C:\\Sumiu']]);
    expect(system.openPath).toHaveBeenCalledTimes(1);
  });

  it('refuses to reveal what is not an absolute path', async () => {
    const { service, system } = setup();
    for (const bad of ['relativo', '', '\\\\.\\C:', 42 as never]) {
      await expect(service.folders.reveal(bad)).rejects.toThrow(TypeError);
    }
    expect(system.openPath).not.toHaveBeenCalled();
    expect(system.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reveals only what the editor can be showing: saved folders, folders just picked, and the drives', async () => {
    const kinds: Record<string, PathKind> = { 'C:\\Salva': 'dir', 'C:\\Nova': 'dir', 'C:\\': 'dir', 'C:\\Windows\\System32': 'dir', 'C:\\Windows\\System32\\cmd.exe': 'file' };
    const { service, system } = setup({ roots: fakeRoots(['C:\\Salva'], kinds) });
    system.pickFolders.mockResolvedValue(['C:\\Nova\\']);
    await service.folders.pick();

    // Case and a trailing backslash do not matter.
    for (const shown of ['c:\\SALVA\\', 'C:\\Nova', 'C:\\']) await service.folders.reveal(shown);
    expect(system.openPath.mock.calls.map(([path]) => path)).toEqual(['C:\\SALVA', 'C:\\Nova', 'C:\\']);

    // Anything else is not in the list: a compromised page could not make Desktop open or show it.
    for (const other of ['C:\\Windows\\System32', 'C:\\Windows\\System32\\cmd.exe', 'C:\\Salva\\dentro', 'D:\\']) {
      await expect(service.folders.reveal(other)).rejects.toThrow(TypeError);
    }
    expect(system.openPath).toHaveBeenCalledTimes(3);
    expect(system.showItemInFolder).not.toHaveBeenCalled();
  });

  it('does not wait for, nor open, a folder that does not answer (a share that is offline), and says so in the log', async () => {
    const share = '\\\\servidor\\x\\';
    const { service, system, log } = setup({ roots: fakeRoots([share], { [share]: 'timeout' }) });
    await expect(service.folders.reveal(share)).resolves.toBeUndefined();
    expect(system.openPath).not.toHaveBeenCalled();
    expect(system.showItemInFolder).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('servidor'));
  });

  it('reads and sets autostart, reporting what is in effect', async () => {
    const { service, autostart } = setup();
    autostart.get.mockReturnValue(true);
    expect(await service.settings.getAutostart()).toEqual({ value: true, supported: true });
    autostart.set.mockReturnValue(false);
    expect(await service.settings.setAutostart(true)).toEqual({ value: false, supported: true });
    expect(autostart.set).toHaveBeenCalledWith(true);
  });

  it('checks for updates and opens only a release page of this repository', async () => {
    const { service, system, checkForUpdate } = setup();
    expect(await service.settings.checkForUpdate()).toEqual({ status: 'up-to-date', current: '1.0.0' });
    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    const release = 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v1.2.0';
    await service.settings.openUpdate(release);
    expect(system.openExternal).toHaveBeenCalledWith(release);
    for (const bad of ['https://evil.example/releases', 'https://github.com/outro/repo/releases', 'ms-settings:privacy']) {
      await expect(service.settings.openUpdate(bad)).rejects.toThrow(TypeError);
    }
    expect(system.openExternal).toHaveBeenCalledTimes(1);
  });

  it('starts the uninstaller through the system hook', async () => {
    const { service, system } = setup();
    await service.settings.uninstall();
    expect(system.startUninstaller).toHaveBeenCalledTimes(1);
  });
});
