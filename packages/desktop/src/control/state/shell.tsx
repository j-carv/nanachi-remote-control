import { createContext, useContext } from 'react';
import type { ControlSection, LogsInfo, OverviewInfo } from '../../common/control-api.js';
import type { DaemonStatus, TailscaleStatus, UpdateCheckResult } from '../../common/types.js';
import type { LogTab } from '../sections/LogsSection.js';
import type { LogViewStore } from './log-view.js';
import type { PairingController } from './pairing-session.js';
import type { ResourceState } from './resource.js';
import type { UninstallGuardController } from './uninstall-guard.js';

export interface ShellValue {
  section: ControlSection;
  /** `pairing` opens the pairing panel as well ("Parear iPhone"). */
  navigate: (section: ControlSection, options?: { pairing?: boolean }) => void;
  /** The pairing panel: whether it is open, its code and its expiry. Kept here so they survive a switch of section. */
  pairing: PairingController;
  /** The tab the Logs section shows. Kept here so it survives a switch of section. */
  logsTab: LogTab;
  setLogsTab: (tab: LogTab) => void;
  /** Whether each log tab's viewer follows the end, and where it is scrolled. Kept here so it survives a switch of section. */
  logView: LogViewStore;
  /** The last check for updates from Settings. Kept here so it survives a switch of section. */
  updateCheck: UpdateCheckResult | null;
  setUpdateCheck: (result: UpdateCheckResult) => void;
  /** The uninstall button's guard. Kept here so it survives a switch of section: a switch must not re-enable the button. */
  uninstallGuard: UninstallGuardController;
  /** The overview, with `daemon` kept live by the daemon status events. */
  overview: ResourceState<OverviewInfo>;
  reloadOverview: (silent?: boolean) => Promise<void>;
  daemon: DaemonStatus | null;
  /** The embedded Tailscale node, kept live by its status events. */
  tailscale: TailscaleStatus | null;
  setTailscale: (status: TailscaleStatus) => void;
  /** When the overview last came back from main (epoch ms), null before the first answer. The Diagnostics section shows it. */
  overviewSyncedAt: number | null;
  /** When the daemon status last arrived as an event (epoch ms), null before the first one. */
  daemonEventAt: number | null;
  /** The logs, kept here so they survive a switch of section. Loaded when the Diagnostics section opens (`enabled: false` in `App`). */
  logs: ResourceState<LogsInfo>;
  reloadLogs: (silent?: boolean) => Promise<void>;
  openSessions: () => void;
  /** The folders editor has edits that are not saved. */
  foldersDirty: boolean;
}

export const ShellContext = createContext<ShellValue | null>(null);

export function useShell(): ShellValue {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('useShell outside the app shell');
  return shell;
}
