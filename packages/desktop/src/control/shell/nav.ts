import { HardDrive, LayoutDashboard, MessagesSquare, Network, ScrollText, Settings, Smartphone, UserRound, type LucideIcon } from 'lucide-react';
import { CONTROL_SECTIONS, type ControlSection } from '../../common/control-api.js';

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
  logs: ScrollText,
  settings: Settings,
  sessions: MessagesSquare,
};

/** In sidebar order; Ctrl+1..8 follow it. The label (sentence case) and the one quiet line under the title are in the dictionary: `sections.<id>.label` and `.description`. */
export const SECTIONS: readonly SectionMeta[] = CONTROL_SECTIONS.map((id) => ({ id, icon: ICONS[id] }));

export function sectionMeta(id: ControlSection): SectionMeta {
  return { id, icon: ICONS[id] };
}
