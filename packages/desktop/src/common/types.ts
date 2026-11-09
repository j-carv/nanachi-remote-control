import type { Language } from './i18n/languages.js';

/** Shapes shared by the main process, the preload bridge and the tests. No Electron imports here. */

/** `starting` while a spawned daemon is not answering yet; `attached` when one already answered. */
export type DaemonState = 'starting' | 'running' | 'attached' | 'stopped' | 'error';

export interface DaemonStatus {
  state: DaemonState;
  /** Port read from `<Desktop data folder>\config.json` (default 7780; the standalone daemon uses 7777). */
  port: number;
  /** Who owns the process: Desktop spawned it, it was already there, or nothing runs. */
  mode: 'spawned' | 'attached' | 'none';
  pid: number | null;
  /** From `/api/health`, when it answered. */
  version: string | null;
  machineName: string | null;
  /**
   * The daemon answers but refuses requests from this PC that do not come through Tailscale (`allowedTailscaleLogins`
   * is set in its config.json), so the local panel cannot use it. The state is still running or attached.
   */
  restricted: boolean;
  /** Reason shown to the user, in Desktop's current language, for `error`, `restricted` and a give-up. */
  message: string | null;
  /** Last lines of `desktop-daemon.log`, filled when `state` is `error`. */
  logTail: string[];
}

export interface PairingCode {
  /** Six digits. */
  code: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Private HTTPS origin discovered through the Windows Tailscale installation. */
  externalOrigin?: string;
}

export type UpdateCheckResult =
  | { status: 'up-to-date'; current: string }
  | { status: 'available'; current: string; latest: string; url: string }
  | { status: 'error'; current: string; message: string };

/** Status of the embedded Tailscale node as the panel sees it. */
export type TailscaleStatus =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'needs_login'; authUrl: string }
  | { state: 'running'; dnsName: string; tailnet: string; ips: string[] }
  | { state: 'error'; message: string };

/** The machine record the PWA keeps in `nanachi.machines` (same shape as `MachineSchema` in the PWA). */
export interface SeedMachine {
  id: string;
  name: string;
  baseUrl: string;
  token: string;
}

/**
 * Answer to the synchronous preload handshake. `machine` is null until Desktop is paired. `language` is Desktop's language
 * when the PWA's own storage has not been given it yet (the first load, and after Desktop's language changed); null
 * otherwise, so a language the user chose inside the PWA is not overwritten at every load.
 */
export interface PreloadInit {
  version: string;
  machine: SeedMachine | null;
  language: Language | null;
}

/** `window.nanachiDesktop`. The PWA declares its own copy of this type; it never imports from here. */
export interface NanachiDesktopBridge {
  readonly version: string;
  status(): Promise<DaemonStatus>;
  onStatus(callback: (status: DaemonStatus) => void): () => void;
  /** Desktop's language changed (from the control center): the page switches at once. Absent from a Desktop older than this. */
  onLanguage(callback: (language: Language) => void): () => void;
  pairingCode(): Promise<PairingCode>;
  getAutostart(): Promise<boolean>;
  setAutostart(value: boolean): Promise<boolean>;
  checkForUpdate(): Promise<UpdateCheckResult>;
  readonly tailscale: {
    status(): Promise<TailscaleStatus>;
    start(): Promise<TailscaleStatus>;
    stop(): Promise<TailscaleStatus>;
    onStatus(callback: (status: TailscaleStatus) => void): () => void;
  };
}
