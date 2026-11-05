import type { MenuItemConstructorOptions } from 'electron';
import { getLanguage, translate, type Language } from '../common/i18n/index.js';
import { statusLabel } from '../common/status-label.js';
import type { DaemonStatus } from '../common/types.js';

export interface TrayActions {
  /** The control center (the main window). */
  openControl(): void;
  /** The PWA window: sessions and chat. */
  openSessions(): void;
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

/** Tooltip: the status line, plus the reason when the daemon is in error. Written in `language` (Desktop's by default). */
export function trayTooltip(status: DaemonStatus, language: Language = getLanguage()): string {
  const label = statusLabel(status, language);
  const text = status.state === 'error' && status.message !== null ? `${label}: ${status.message}` : label;
  return text.length <= TOOLTIP_LIMIT ? text : `${text.slice(0, TOOLTIP_LIMIT - 1)}…`;
}

/**
 * The tray menu from the contract: status line, control center, sessions, pairing code, start with Windows, quit. Written
 * in `language` (Desktop's by default); the caller builds it again when the language changes.
 */
export function buildTrayMenu(input: TrayMenuInput, language: Language = getLanguage()): MenuItemConstructorOptions[] {
  const { status, actions } = input;
  const canPair = status.state === 'running' || status.state === 'attached';
  return [
    { label: statusLabel(status, language), enabled: false },
    { type: 'separator' },
    { label: translate(language, 'main.tray.open'), click: () => actions.openControl() },
    { label: translate(language, 'main.tray.openSessions'), click: () => actions.openSessions() },
    { label: translate(language, 'main.tray.pairingCode'), enabled: canPair, click: () => actions.generatePairingCode() },
    {
      label: translate(language, 'main.tray.startWithWindows'),
      type: 'checkbox',
      checked: input.autostart,
      enabled: input.autostartSupported,
      click: (item) => actions.setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: translate(language, 'main.tray.quit'), click: () => actions.quit() },
  ];
}
