/** Tecla da barra do celular: `data` é o que vai para o PTY (sequências ANSI para as setas). */
export interface TerminalKey {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly data: string;
}

/** Teclas que o teclado do iPhone não tem. Ordem = ordem na barra. */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
  { id: 'esc', label: 'Esc', ariaLabel: 'Escape', data: '\x1b' },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab', data: '\t' },
  { id: 'ctrl-c', label: 'Ctrl+C', ariaLabel: 'Ctrl+C, interromper', data: '\x03' },
  { id: 'ctrl-d', label: 'Ctrl+D', ariaLabel: 'Ctrl+D, fim de entrada', data: '\x04' },
  { id: 'up', label: '↑', ariaLabel: 'Seta para cima', data: '\x1b[A' },
  { id: 'down', label: '↓', ariaLabel: 'Seta para baixo', data: '\x1b[B' },
  { id: 'right', label: '→', ariaLabel: 'Seta para a direita', data: '\x1b[C' },
  { id: 'left', label: '←', ariaLabel: 'Seta para a esquerda', data: '\x1b[D' },
  { id: 'enter', label: 'Enter', ariaLabel: 'Enter', data: '\r' },
];
