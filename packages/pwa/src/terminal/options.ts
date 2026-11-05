import type { ILinkHandler, ITerminalOptions, ITheme } from '@xterm/xterm';
import { webLinkOf } from './links.js';

/** Linhas guardadas acima da tela (rolar para ver saída antiga). */
export const TERMINAL_SCROLLBACK = 5000;

/** Mesma pilha monoespaçada do bloco de código do chat (fonte do sistema, sem download). */
export const TERMINAL_FONT_FAMILY = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Fixed dark palette, the same in light and dark mode, with ANSI colours readable on the dark background. */
const THEME: ITheme = {
  background: '#0b0d12',
  foreground: '#eef1f8',
  cursor: '#b9a8ff',
  cursorAccent: '#0b0d12',
  selectionBackground: 'rgba(124, 92, 255, 0.45)',
  black: '#151923',
  red: '#f87171',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#cbd5e1',
  brightBlack: '#5c6578',
  brightRed: '#fca5a5',
  brightGreen: '#6ee7b7',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
};

/** Link (OSC 8) da saída: só http/https abre, em aba nova e sem acesso à página de origem. O resto é ignorado. */
const LINK_HANDLER: ILinkHandler = {
  activate: (_event, text) => {
    const url = webLinkOf(text);
    if (url !== undefined) window.open(url, '_blank', 'noopener,noreferrer');
  },
};

export const TERMINAL_OPTIONS: ITerminalOptions = {
  scrollback: TERMINAL_SCROLLBACK,
  fontFamily: TERMINAL_FONT_FAMILY,
  fontSize: 13,
  cursorBlink: true,
  theme: THEME,
  linkHandler: LINK_HANDLER,
};
