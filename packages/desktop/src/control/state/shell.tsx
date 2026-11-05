import { createContext, useContext } from 'react';
import type { ControlSection, OverviewInfo } from '../../common/control-api.js';
import type { DaemonStatus, TailscaleStatus } from '../../common/types.js';
import type { ResourceState } from './resource.js';

export interface ShellValue {
  section: ControlSection;
  /** `pairing` asks the devices section to open the pairing panel on arrival ("Parear iPhone"). */
  navigate: (section: ControlSection, options?: { pairing?: boolean }) => void;
  /** Reads and clears the pairing request, once. */
  takePairingRequest: () => boolean;
  /** The overview, with `daemon` kept live by the daemon status events. */
  overview: ResourceState<OverviewInfo>;
  reloadOverview: (silent?: boolean) => Promise<void>;
  daemon: DaemonStatus | null;
  /** The embedded Tailscale node, kept live by its status events. */
  tailscale: TailscaleStatus | null;
  setTailscale: (status: TailscaleStatus) => void;
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
