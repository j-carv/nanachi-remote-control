import {
  ALLOWED_CONTROL_EVENT_CHANNELS,
  ALLOWED_CONTROL_INVOKE_CHANNELS,
  CONTROL_EVENT_CHANNELS,
  CONTROL_INVOKE_CHANNELS,
} from '../common/channels.js';
import type {
  AgentAccountsInfo,
  ControlApi,
  ControlResult,
  DeviceInfo,
  FoldersState,
  LogsInfo,
  OverviewInfo,
  SaveRootsResult,
  WindowState,
} from '../common/control-api.js';
import type { DaemonStatus, PairingCode, TailscaleStatus, UpdateCheckResult } from '../common/types.js';
import type { BridgeIpc } from './bridge.js';

/**
 * Builds `window.nanachiControl`. Every call goes through a channel from the control allowlist (never the panel's); a
 * channel that is not on it throws before anything reaches `ipcRenderer`. Event listeners receive the payload only,
 * never the IPC event. What goes in is validated by `main/control-ipc.ts`; what comes back is typed by `ControlApi`.
 */
export function createControlBridge(ipc: BridgeIpc, version: string): ControlApi {
  function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (!ALLOWED_CONTROL_INVOKE_CHANNELS.has(channel)) throw new Error(`canal não permitido: ${channel}`);
    return ipc.invoke(channel, ...args) as Promise<T>;
  }

  function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
    if (!ALLOWED_CONTROL_EVENT_CHANNELS.has(channel)) throw new Error(`canal não permitido: ${channel}`);
    if (typeof callback !== 'function') throw new TypeError('callback precisa ser uma função');
    const listener = (_event: unknown, payload: unknown): void => callback(payload as T);
    ipc.on(channel, listener);
    return () => ipc.removeListener(channel, listener);
  }

  const c = CONTROL_INVOKE_CHANNELS;
  return {
    version,
    window: {
      minimize: () => invoke<void>(c.windowMinimize),
      toggleMaximize: () => invoke<WindowState>(c.windowToggleMaximize),
      close: () => invoke<void>(c.windowClose),
      state: () => invoke<WindowState>(c.windowState),
      onState: (callback) => subscribe<WindowState>(CONTROL_EVENT_CHANNELS.windowState, callback),
    },
    overview: () => invoke<ControlResult<OverviewInfo>>(c.overview),
    onDaemonStatus: (callback) => subscribe<DaemonStatus>(CONTROL_EVENT_CHANNELS.daemonStatus, callback),
    restartDaemon: () => invoke<ControlResult<DaemonStatus>>(c.restartDaemon),
    openSessions: () => invoke<void>(c.openSessions),
    openDataFolder: () => invoke<void>(c.openDataFolder),
    folders: {
      get: () => invoke<ControlResult<FoldersState>>(c.foldersGet),
      pick: () => invoke<string[]>(c.foldersPick),
      // `confirmedBusy` is forwarded only when the page gave it, so a plain save sends two arguments.
      save: (roots, restart, confirmedBusy) =>
        confirmedBusy === undefined
          ? invoke<ControlResult<SaveRootsResult>>(c.foldersSave, roots, restart)
          : invoke<ControlResult<SaveRootsResult>>(c.foldersSave, roots, restart, confirmedBusy),
      reveal: (path) => invoke<void>(c.foldersReveal, path),
    },
    devices: {
      list: () => invoke<ControlResult<DeviceInfo[]>>(c.devicesList),
      revoke: (id) => invoke<ControlResult<DeviceInfo[]>>(c.devicesRevoke, id),
      pairingCode: () => invoke<ControlResult<PairingCode>>(c.devicesPairingCode),
    },
    accounts: {
      // `refresh` is forwarded only when the page gave it, so a plain `list()` sends no arguments.
      list: (refresh) =>
        refresh === undefined
          ? invoke<ControlResult<AgentAccountsInfo[]>>(c.accountsList)
          : invoke<ControlResult<AgentAccountsInfo[]>>(c.accountsList, refresh),
      setActive: (agentId, accountId) => invoke<ControlResult<AgentAccountsInfo[]>>(c.accountsSetActive, agentId, accountId),
    },
    tailscale: {
      status: () => invoke<TailscaleStatus>(c.tailscaleStatus),
      start: () => invoke<TailscaleStatus>(c.tailscaleStart),
      stop: () => invoke<TailscaleStatus>(c.tailscaleStop),
      onStatus: (callback) => subscribe<TailscaleStatus>(CONTROL_EVENT_CHANNELS.tailscaleStatus, callback),
      openLogin: (url) => invoke<void>(c.tailscaleOpenLogin, url),
    },
    logs: {
      get: () => invoke<LogsInfo>(c.logsGet),
      openFolder: () => invoke<void>(c.logsOpenFolder),
    },
    settings: {
      getAutostart: () => invoke<{ value: boolean; supported: boolean }>(c.settingsGetAutostart),
      setAutostart: (value) => invoke<{ value: boolean; supported: boolean }>(c.settingsSetAutostart, value),
      checkForUpdate: () => invoke<UpdateCheckResult>(c.settingsCheckForUpdate),
      openUpdate: (url) => invoke<void>(c.settingsOpenUpdate, url),
      uninstall: () => invoke<void>(c.settingsUninstall),
    },
  };
}
