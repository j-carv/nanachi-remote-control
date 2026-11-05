import type { MenuItemConstructorOptions } from 'electron';
import { statusLabel } from '../common/status-label.js';
import type { DaemonStatus } from '../common/types.js';

export interface TrayActions {
  openPanel(): void;
  generatePairingCode(): void;
  setAutostart(enabled: boolean): void;
  quit(): void;
}

export interface TrayMenuInput {
  status: DaemonStatus;
  autostart: boolean;
  autostartSupported: boolean;
  actions: TrayActions;
}

/** Windows cuts tooltips at 127 characters. */
const TOOLTIP_LIMIT = 127;

/** Tooltip: the status line, plus the reason when the daemon is in error. */
export function trayTooltip(status: DaemonStatus): string {
  const label = statusLabel(status);
  const text = status.state === 'error' && status.message !== null ? `${label}: ${status.message}` : label;
  return text.length <= TOOLTIP_LIMIT ? text : `${text.slice(0, TOOLTIP_LIMIT - 1)}…`;
}

/** The tray menu from the contract: status line, panel, pairing code, start with Windows, quit. */
export function buildTrayMenu(input: TrayMenuInput): MenuItemConstructorOptions[] {
  const { status, actions } = input;
  const canPair = status.state === 'running' || status.state === 'attached';
  return [
    { label: statusLabel(status), enabled: false },
    { type: 'separator' },
    { label: 'Abrir painel', click: () => actions.openPanel() },
    { label: 'Gerar código de pareamento', enabled: canPair, click: () => actions.generatePairingCode() },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: input.autostart,
      enabled: input.autostartSupported,
      click: (item) => actions.setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: 'Sair', click: () => actions.quit() },
  ];
}
