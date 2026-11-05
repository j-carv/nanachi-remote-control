/** O que a tecla faz: manda bytes ao PTY, liga uma trava (Ctrl/Alt) ou cola o conteúdo da área de transferência. */
export type TerminalKeyAction =
  | { readonly type: 'send'; readonly data: string }
  | { readonly type: 'sticky'; readonly key: 'ctrl' | 'alt' }
  | { readonly type: 'paste' };

/** Tecla da barra do celular. `label` é o texto do botão (setas viram ícone na tela). */
export interface TerminalKey {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly action: TerminalKeyAction;
}

/** Teclas que o teclado do iPhone não tem. Ordem = ordem na barra (que rola na horizontal). */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
  { id: 'esc', label: 'Esc', ariaLabel: 'Escape', action: { type: 'send', data: '\x1b' } },
  { id: 'tab', label: 'Tab', ariaLabel: 'Tab', action: { type: 'send', data: '\t' } },
  {
    id: 'ctrl',
    label: 'Ctrl',
    ariaLabel: 'Ctrl, a próxima tecla vira controle',
    action: { type: 'sticky', key: 'ctrl' },
  },
  {
    id: 'alt',
    label: 'Alt',
    ariaLabel: 'Alt, a próxima tecla vai com Alt',
    action: { type: 'sticky', key: 'alt' },
  },
  { id: 'up', label: '↑', ariaLabel: 'Seta para cima', action: { type: 'send', data: '\x1b[A' } },
  { id: 'down', label: '↓', ariaLabel: 'Seta para baixo', action: { type: 'send', data: '\x1b[B' } },
  { id: 'left', label: '←', ariaLabel: 'Seta para a esquerda', action: { type: 'send', data: '\x1b[D' } },
  { id: 'right', label: '→', ariaLabel: 'Seta para a direita', action: { type: 'send', data: '\x1b[C' } },
  { id: 'pipe', label: '|', ariaLabel: 'Barra vertical', action: { type: 'send', data: '|' } },
  { id: 'tilde', label: '~', ariaLabel: 'Til', action: { type: 'send', data: '~' } },
  { id: 'slash', label: '/', ariaLabel: 'Barra', action: { type: 'send', data: '/' } },
  { id: 'dash', label: '-', ariaLabel: 'Hífen', action: { type: 'send', data: '-' } },
  { id: 'home', label: 'Home', ariaLabel: 'Home, início da linha', action: { type: 'send', data: '\x1b[H' } },
  { id: 'end', label: 'End', ariaLabel: 'End, fim da linha', action: { type: 'send', data: '\x1b[F' } },
  { id: 'pgup', label: 'PgUp', ariaLabel: 'Page Up', action: { type: 'send', data: '\x1b[5~' } },
  { id: 'pgdn', label: 'PgDn', ariaLabel: 'Page Down', action: { type: 'send', data: '\x1b[6~' } },
  { id: 'paste', label: 'Colar', ariaLabel: 'Colar da área de transferência', action: { type: 'paste' } },
  { id: 'enter', label: 'Enter', ariaLabel: 'Enter', action: { type: 'send', data: '\r' } },
];
