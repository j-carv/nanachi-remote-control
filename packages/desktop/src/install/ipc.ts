import type { Language } from '../common/i18n/languages.js';
import type { InstallProgress } from './install.js';
import type { RunningProcess } from './processes.js';
import type { UninstallProgress } from './uninstall.js';

/** Contract between the installer / uninstaller windows (their pages) and their main processes. Types only. */

export const INSTALLER_CHANNELS = {
  init: 'installer:init',
  chooseFolder: 'installer:choose-folder',
  validateTarget: 'installer:validate-target',
  start: 'installer:start',
  answerClose: 'installer:answer-close',
  launch: 'installer:launch',
  minimize: 'installer:minimize',
  close: 'installer:close',
  progress: 'installer:progress',
  askClose: 'installer:ask-close',
} as const;

export const UNINSTALLER_CHANNELS = {
  init: 'uninstaller:init',
  start: 'uninstaller:start',
  minimize: 'uninstaller:minimize',
  close: 'uninstaller:close',
  progress: 'uninstaller:progress',
} as const;

export interface InstallerInit {
  version: string;
  /** Default install folder (or `--target`). */
  target: string;
  desktopShortcut: boolean;
  startWithWindows: boolean;
  /** Any of `--target`, `--no-shortcuts`, `--no-registry`, `--no-launch` is set: nothing real is touched. */
  testMode: boolean;
  /** The language of the page: the installer runs before any setting exists, so it is the system locale's. */
  language: Language;
}

export interface InstallRequest {
  target: string;
  desktopShortcut: boolean;
  startWithWindows: boolean;
}

export type TargetValidation = { ok: true } | { ok: false; reason: string };
export type InstallOutcome = { ok: true } | { ok: false; message: string };

export interface InstallerApi {
  init(): Promise<InstallerInit>;
  /** Native folder picker; `null` when cancelled. */
  chooseFolder(current: string): Promise<string | null>;
  validateTarget(target: string): Promise<TargetValidation>;
  /** Resolves when the install finished (or failed). Progress arrives through `onProgress`. */
  start(request: InstallRequest): Promise<InstallOutcome>;
  onProgress(callback: (progress: InstallProgress) => void): () => void;
  onAskClose(callback: (processes: RunningProcess[]) => void): () => void;
  answerClose(proceed: boolean): void;
  /** Starts the installed Nanachi and closes the installer. */
  launch(): Promise<void>;
  minimize(): void;
  close(): void;
}

export interface UninstallerInit {
  installDir: string;
  version: string;
  /** The data folder that stays (or goes, when ticked). */
  dataDir: string;
  testMode: boolean;
  deleteData: boolean;
  /** The language of the page: Desktop's setting when it has one, else the system locale's. */
  language: Language;
}

export type UninstallOutcome = { ok: true; warnings: string[] } | { ok: false; message: string };

export interface UninstallerApi {
  init(): Promise<UninstallerInit>;
  start(request: { deleteData: boolean }): Promise<UninstallOutcome>;
  onProgress(callback: (progress: UninstallProgress) => void): () => void;
  minimize(): void;
  close(): void;
}
