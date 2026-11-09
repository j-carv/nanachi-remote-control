import { HardDrive, LayoutDashboard, MessagesSquare, Network, ScrollText, Settings, Smartphone, Stethoscope, UserRound, type LucideIcon } from 'lucide-react';
import { CONTROL_SECTIONS, SIDEBAR_SECTIONS, type ControlSection } from '../../common/control-api.js';

export interface SectionMeta {
  id: ControlSection;
  icon: LucideIcon;
}

const ICONS: Record<ControlSection, LucideIcon> = {
  overview: LayoutDashboard,
  folders: HardDrive,
  devices: Smartphone,
  accounts: UserRound,
  tailscale: Network,
  diagnostics: Stethoscope,
  logs: ScrollText,
  settings: Settings,
  sessions: MessagesSquare,
};

/** In sidebar order. The label (sentence case) and the one quiet line under the title are in the dictionary: `sections.<id>.label` and `.description`. */
export const SECTIONS: readonly SectionMeta[] = SIDEBAR_SECTIONS.map((id) => ({ id, icon: ICONS[id] }));

export function sectionMeta(id: ControlSection): SectionMeta {
  return { id, icon: ICONS[id] };
}

/** The shortcut that selects a section (`Ctrl+6`), or null when the section has no number (see `CONTROL_SECTIONS`). */
export function shortcutOf(id: ControlSection): string | null {
  const position = CONTROL_SECTIONS.findIndex((section) => section === id);
  return position === -1 ? null : `Ctrl+${position + 1}`;
}
