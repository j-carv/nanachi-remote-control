import { INVOKE_CHANNELS, SYNC_CHANNELS } from '../common/channels.js';
import type {
  DaemonStatus,
  PairingCode,
  PreloadInit,
  TailscaleStatus,
  UpdateCheckResult,
} from '../common/types.js';

/** What a handler needs to know about who is calling. */
export interface IpcSender {
  /** URL of the frame that sent the message; absent when the frame is already gone. */
  senderFrame?: { url: string } | null;
}

interface SyncEvent extends IpcSender {
  returnValue: unknown;
}

/** The part of `ipcMain` used here. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcSender, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: SyncEvent) => void): void;
  removeListener(channel: string, listener: (event: SyncEvent) => void): void;
}

export interface IpcDeps {
  ipcMain: IpcMainLike;
  /** Only the panel, loaded from the daemon's own origin, may call in. */
  isTrustedUrl(url: string | undefined): boolean;
  status(): DaemonStatus;
  pairingCode(): Promise<PairingCode>;
  getAutostart(): boolean;
  setAutostart(enabled: boolean): boolean;
  tailscale: {
    status(): TailscaleStatus;
    start(): Promise<TailscaleStatus>;
    stop(): Promise<TailscaleStatus>;
  };
  checkForUpdate(): Promise<UpdateCheckResult>;
  init(): PreloadInit;
}

export class UntrustedSenderError extends Error {
  constructor() {
    super('chamada recusada: origem não confiável');
    this.name = 'UntrustedSenderError';
  }
}

/**
 * Registers the fixed channel list. Every handler first checks the sender frame, then validates its own input; extra
 * arguments from the page are ignored. Returns a function that removes everything it registered.
 */
export function registerIpc(deps: IpcDeps): () => void {
  const { ipcMain } = deps;

  function trusted(event: IpcSender): void {
    if (!deps.isTrustedUrl(event.senderFrame?.url)) throw new UntrustedSenderError();
  }

  function handle(channel: string, run: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      trusted(event);
      return run(...args);
    });
  }

  handle(INVOKE_CHANNELS.status, () => deps.status());
  handle(INVOKE_CHANNELS.pairingCode, () => deps.pairingCode());
  handle(INVOKE_CHANNELS.getAutostart, () => deps.getAutostart());
  handle(INVOKE_CHANNELS.setAutostart, (value) => {
    if (typeof value !== 'boolean') throw new TypeError('setAutostart espera true ou false');
    return deps.setAutostart(value);
  });
  handle(INVOKE_CHANNELS.tailscaleStatus, () => deps.tailscale.status());
  handle(INVOKE_CHANNELS.tailscaleStart, () => deps.tailscale.start());
  handle(INVOKE_CHANNELS.tailscaleStop, () => deps.tailscale.stop());
  handle(INVOKE_CHANNELS.checkForUpdate, () => deps.checkForUpdate());

  // Synchronous handshake of the preload: answered from memory, and a stranger gets nothing (not even an error).
  const onInit = (event: SyncEvent): void => {
    event.returnValue = deps.isTrustedUrl(event.senderFrame?.url) ? deps.init() : null;
  };
  ipcMain.on(SYNC_CHANNELS.init, onInit);

  return () => {
    for (const channel of Object.values(INVOKE_CHANNELS)) ipcMain.removeHandler(channel);
    ipcMain.removeListener(SYNC_CHANNELS.init, onInit);
  };
}
