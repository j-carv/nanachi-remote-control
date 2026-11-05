import { HardDrive, LayoutDashboard, MessagesSquare, Network, ScrollText, Settings, Smartphone, UserRound, type LucideIcon } from 'lucide-react';
import { CONTROL_SECTIONS, type ControlSection } from '../../common/control-api.js';

export interface SectionMeta {
  id: ControlSection;
  /** Sidebar label (sentence case). */
  label: string;
  /** One quiet line under the page title. */
  description: string;
  icon: LucideIcon;
}

const META: Record<ControlSection, Omit<SectionMeta, 'id'>> = {
  overview: { label: 'Visão geral', description: 'Como o Nanachi está agora neste PC.', icon: LayoutDashboard },
  folders: { label: 'Pastas e discos', description: 'Escolha onde o Nanachi pode abrir sessões.', icon: HardDrive },
  devices: { label: 'Aparelhos', description: 'Os aparelhos que podem usar este PC.', icon: Smartphone },
  accounts: { label: 'Contas dos agentes', description: 'As contas de cada agente e qual delas as novas sessões usam.', icon: UserRound },
  tailscale: { label: 'Tailscale', description: 'Acesso ao Nanachi fora de casa, pelo Tailscale embutido.', icon: Network },
  logs: { label: 'Logs', description: 'O que o daemon e o Tailscale escrevem agora.', icon: ScrollText },
  settings: { label: 'Ajustes', description: 'Início com o Windows, atualizações e dados.', icon: Settings },
};

/** In sidebar order; Ctrl+1..7 follow it. */
export const SECTIONS: readonly SectionMeta[] = CONTROL_SECTIONS.map((id) => ({ id, ...META[id] }));

export function sectionMeta(id: ControlSection): SectionMeta {
  return { id, ...META[id] };
}

export const SESSIONS_ACTION = { label: 'Abrir sessões', icon: MessagesSquare } as const;
