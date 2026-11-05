import { ALLOWED_EVENT_CHANNELS, ALLOWED_INVOKE_CHANNELS, EVENT_CHANNELS, INVOKE_CHANNELS } from '../common/channels.js';
import type { Language } from '../common/i18n/languages.js';
import type {
  DaemonStatus,
  NanachiDesktopBridge,
  PairingCode,
  TailscaleStatus,
  UpdateCheckResult,
} from '../common/types.js';

/** The two `ipcRenderer` calls the bridge may use, and nothing else. */
export interface BridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

/**
 * Builds `window.nanachiDesktop`. Every call goes through a channel from the fixed allowlist; a channel that is not
 * on it throws before anything reaches `ipcRenderer`. Event listeners receive the payload only, never the IPC event.
 * Validation of what comes back is the page's job; validation of what goes in is `main/ipc.ts`.
 */
export function createBridge(ipc: BridgeIpc, version: string): NanachiDesktopBridge {
  function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) throw new Error(`canal não permitido: ${channel}`);
    return ipc.invoke(channel, ...args) as Promise<T>;
  }

  function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
    if (!ALLOWED_EVENT_CHANNELS.has(channel)) throw new Error(`canal não permitido: ${channel}`);
    if (typeof callback !== 'function') throw new TypeError('callback precisa ser uma função');
    const listener = (_event: unknown, payload: unknown): void => callback(payload as T);
    ipc.on(channel, listener);
    return () => ipc.removeListener(channel, listener);
  }

  return {
    version,
    status: () => invoke<DaemonStatus>(INVOKE_CHANNELS.status),
    onStatus: (callback) => subscribe<DaemonStatus>(EVENT_CHANNELS.status, callback),
    onLanguage: (callback) => subscribe<Language>(EVENT_CHANNELS.language, callback),
    pairingCode: () => invoke<PairingCode>(INVOKE_CHANNELS.pairingCode),
    getAutostart: () => invoke<boolean>(INVOKE_CHANNELS.getAutostart),
    setAutostart: (value) => invoke<boolean>(INVOKE_CHANNELS.setAutostart, value),
    checkForUpdate: () => invoke<UpdateCheckResult>(INVOKE_CHANNELS.checkForUpdate),
    tailscale: {
      status: () => invoke<TailscaleStatus>(INVOKE_CHANNELS.tailscaleStatus),
      start: () => invoke<TailscaleStatus>(INVOKE_CHANNELS.tailscaleStart),
      stop: () => invoke<TailscaleStatus>(INVOKE_CHANNELS.tailscaleStop),
      onStatus: (callback) => subscribe<TailscaleStatus>(EVENT_CHANNELS.tailscaleStatus, callback),
    },
  };
}
