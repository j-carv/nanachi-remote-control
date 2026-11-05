/**
 * Contract between the control center window (`src/control`, the renderer) and the main process. The preload
 * `src/preload/control.ts` exposes `window.nanachiControl: ControlApi`; every method maps to one channel of
 * `CONTROL_INVOKE_CHANNELS` in `channels.ts`, and every event to one of `CONTROL_EVENT_CHANNELS`. No Electron imports.
 *
 * The device token never crosses this boundary: the main process calls the daemon API itself and returns plain data.
 * User-visible strings produced by the main process (messages, errors) are already in Desktop's current language
 * (pt-BR, English or Spanish); the renderer shows them as they come.
 */
import type { Language } from './i18n/languages.js';
import type { DaemonStatus, PairingCode, TailscaleStatus, UpdateCheckResult } from './types.js';

/**
 * Sections of the control center, in sidebar order. Ctrl+1..8 select them. `sessions` is the PWA (the same app as on the
 * phone), drawn by main in a view over the content area while this section is on screen.
 */
export const CONTROL_SECTIONS = ['overview', 'folders', 'devices', 'accounts', 'tailscale', 'logs', 'settings', 'sessions'] as const;
export type ControlSection = (typeof CONTROL_SECTIONS)[number];

/**
 * A failure the renderer can show as is: `message` is already in Desktop's language and safe to display. The one exception is
 * an empty `message`: the page itself made that error (a call that rejected, so main never answered) and words it in its own
 * language.
 */
export interface ControlError {
  ok: false;
  code: 'daemon_unavailable' | 'not_paired' | 'unauthorized' | 'invalid_input' | 'io' | 'not_own_daemon' | 'unknown';
  message: string;
}
export type ControlResult<T> = { ok: true; value: T } | ControlError;

/** One logical drive of this PC (from `Win32_LogicalDisk`, with a letter-probe fallback). */
export interface DriveInfo {
  /** `C:\` (always with the trailing backslash). */
  root: string;
  /** Volume label, or null when unknown. */
  label: string | null;
  kind: 'fixed' | 'removable' | 'network' | 'optical' | 'unknown';
  /** Bytes; null when unknown. */
  totalBytes: number | null;
  freeBytes: number | null;
}

/** One entry of `allowedRoots` as the editor shows it. */
export interface RootEntry {
  /** Normalized absolute path (`C:\Projetos`, or a drive root `D:\`). */
  path: string;
  /** False when the folder does not exist (anymore); kept in the list but flagged. */
  exists: boolean;
  /** Set when another entry already contains this one (redundant, still allowed). */
  coveredBy: string | null;
}

export interface FoldersState {
  /**
   * `allowedRoots` as saved in Desktop's config.json, or, for a daemon Desktop did not start, the list that daemon
   * reports. Empty (and `rootsUnknown`) when that daemon could not be asked: Desktop's own list is not its list.
   */
  roots: RootEntry[];
  /** Attached to a daemon Desktop did not start and it could not say which folders it uses: `roots` is empty, not the real list. */
  rootsUnknown: boolean;
  drives: DriveInfo[];
  /** False when Desktop is attached to a daemon it did not start: the list is read-only then. */
  editable: boolean;
  /** Saved roots differ from what the running daemon uses (saved, restart pending). */
  restartPending: boolean;
  /** Sessions that a restart would interrupt (running or awaiting permission). */
  busySessions: number;
}

export interface SaveRootsResult {
  /** The state after the call; `busySessions` is what main just read, not what the screen showed. */
  state: FoldersState;
  /**
   * `restarted`: saved, and the restarted daemon is running with the new list.
   * `starting`: saved and restarted, but the daemon had not answered yet when the wait ended.
   * `restart_failed`: saved, but the daemon did not come back up (the new list applies once it does).
   * `pending`: saved; applies on the next restart.
   * `needs_confirmation`: nothing was saved or restarted, because `state.busySessions` sessions would be interrupted
   *   and the caller did not confirm that many; call again with `confirmedBusy` set to that count.
   */
  applied: 'restarted' | 'starting' | 'restart_failed' | 'pending' | 'needs_confirmation';
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
  /** The device Nanachi Desktop paired for itself (its panel uses it). */
  isThisApp: boolean;
}

export interface AccountInfo {
  id: string;
  name: string;
  principal: boolean;
  active: boolean;
  status: 'logged_in' | 'logged_out' | 'unknown';
  /** Account e-mail or name as the agent reports it, when known. */
  identity: string | null;
}

export interface AgentAccountsInfo {
  agentId: string;
  agentName: string;
  /** False for agents without an account adapter (only the principal login exists). */
  multiAccount: boolean;
  accounts: AccountInfo[];
}

export interface OverviewInfo {
  daemon: DaemonStatus;
  tailscale: TailscaleStatus;
  /** Null when the daemon could not be asked (down, not paired). */
  activity: { workspaces: number; sessions: number; busySessions: number; devices: number } | null;
  dataFolder: string;
  appVersion: string;
}

export interface LogsInfo {
  /** Last lines of `desktop-daemon.log` (at most 500). */
  daemon: string[];
  /** Last lines of the tsnet sidecar log (at most 500); empty when it never ran. */
  tailscale: string[];
}

export type WindowState = { maximized: boolean; focused: boolean };

/**
 * What the page tells main about the place where the sessions view (the PWA) may be drawn, every time any of it changes.
 * Main owns the view: it sets the bounds from `x`, `y`, `width` and `height`, and shows it only while `active` is true and
 * `covered` is false (and the daemon is ready); otherwise it hides it.
 */
export interface SessionsViewport {
  /** The content area of the section in DIP, relative to the window's content (the page's own top-left corner). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The sessions section is the one on screen, and the daemon is ready (the page shows its own state otherwise). */
  active: boolean;
  /** A dialog or a toast of the control center needs the area: the view steps aside until it is gone. */
  covered: boolean;
}

/** What main says about the sessions view: `crashed` is a page that kept dying, which main stopped replacing until the section is opened again. */
export type SessionsViewState = 'ok' | 'crashed';

export interface ControlApi {
  readonly version: string;
  /** The language of Desktop when the page started; changes arrive through `onLanguage`. */
  readonly language: Language;
  /** Main asks the page to show a section (the tray's "Abrir sessões" while the window is already open). */
  onNavigate(callback: (section: ControlSection) => void): () => void;
  /** Desktop's language changed (from Ajustes here, or anywhere else): the page switches at once. */
  onLanguage(callback: (language: Language) => void): () => void;
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<WindowState>;
    /** Hides the window (Desktop keeps running in the tray). */
    close(): Promise<void>;
    state(): Promise<WindowState>;
    onState(callback: (state: WindowState) => void): () => void;
  };
  overview(): Promise<ControlResult<OverviewInfo>>;
  onDaemonStatus(callback: (status: DaemonStatus) => void): () => void;
  restartDaemon(): Promise<ControlResult<DaemonStatus>>;
  openDataFolder(): Promise<void>;
  sessions: {
    /** Reports where the sessions view may be drawn (see `SessionsViewport`). Main validates the numbers and clamps them to the window. */
    setViewport(viewport: SessionsViewport): Promise<void>;
    /** Main tells the page when the view gave up and when it is fine again (see `SessionsViewState`). */
    onState(callback: (state: SessionsViewState) => void): () => void;
  };
  folders: {
    get(): Promise<ControlResult<FoldersState>>;
    /** Native multi-select folder picker. Returns the chosen absolute paths (empty when cancelled); saves nothing. */
    pick(): Promise<string[]>;
    /**
     * Validates and writes `allowedRoots`; restarts the daemon only when `restart` is true and Desktop owns it. Main reads
     * the busy sessions itself right before restarting and refuses (`needs_confirmation`) unless `confirmedBusy`, the
     * number of sessions the user agreed to interrupt, covers them.
     */
    save(roots: string[], restart: boolean, confirmedBusy?: number): Promise<ControlResult<SaveRootsResult>>;
    reveal(path: string): Promise<void>;
  };
  devices: {
    list(): Promise<ControlResult<DeviceInfo[]>>;
    revoke(id: string): Promise<ControlResult<DeviceInfo[]>>;
    pairingCode(): Promise<ControlResult<PairingCode>>;
  };
  accounts: {
    /** `refresh: true` makes the daemon check the logins again (the "Atualizar" button); without it, cached results (up to 5 min old). */
    list(refresh?: boolean): Promise<ControlResult<AgentAccountsInfo[]>>;
    setActive(agentId: string, accountId: string): Promise<ControlResult<AgentAccountsInfo[]>>;
  };
  tailscale: {
    status(): Promise<TailscaleStatus>;
    start(): Promise<TailscaleStatus>;
    stop(): Promise<TailscaleStatus>;
    onStatus(callback: (status: TailscaleStatus) => void): () => void;
    /** Opens a `needs_login` auth URL in the default browser (only `https://login.tailscale.com/...`). */
    openLogin(url: string): Promise<void>;
  };
  logs: {
    get(): Promise<LogsInfo>;
    openFolder(): Promise<void>;
  };
  settings: {
    /** Switches Desktop's language: the tray, the messages of main, this page and the embedded PWA follow. Resolves with the language in effect. */
    setLanguage(language: Language): Promise<Language>;
    getAutostart(): Promise<{ value: boolean; supported: boolean }>;
    setAutostart(value: boolean): Promise<{ value: boolean; supported: boolean }>;
    checkForUpdate(): Promise<UpdateCheckResult>;
    /** Opens the external release page of an available update. */
    openUpdate(url: string): Promise<void>;
    /** Starts `Nanachi.exe --uninstall` (its own window asks for confirmation). */
    uninstall(): Promise<void>;
  };
}
