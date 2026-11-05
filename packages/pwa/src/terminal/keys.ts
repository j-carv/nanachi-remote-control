import { t } from '../i18n/index.js';

/** O que a tecla faz: manda bytes ao PTY, liga uma trava (Ctrl/Alt) ou cola o conteúdo da área de transferência. */
export type TerminalKeyAction =
  | { readonly type: 'send'; readonly data: string }
  | { readonly type: 'sticky'; readonly key: 'ctrl' | 'alt' }
  | { readonly type: 'paste' };

/** Ids of the keys on the bar. Each one has its accessible name in `terminal.json` under `keys.ariaLabel`. */
export type TerminalKeyId =
  | 'esc'
  | 'tab'
  | 'ctrl'
  | 'alt'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pipe'
  | 'tilde'
  | 'slash'
  | 'dash'
  | 'home'
  | 'end'
  | 'pgup'
  | 'pgdn'
  | 'paste'
  | 'enter';

/**
 * Tecla da barra do celular. `label` é o texto do botão (setas viram ícone na tela). `label` and `ariaLabel` are read
 * when used, so they follow the current language.
 */
export interface TerminalKey {
  readonly id: TerminalKeyId;
  readonly label: string;
  readonly ariaLabel: string;
  readonly action: TerminalKeyAction;
}

/**
 * Builds a key. `label` is the text on the keycap: a fixed text for the keys that carry the same name on every keyboard
 * (Esc, Ctrl, Enter, symbols), or a function for the one that is a word to translate ("Colar" / "Paste").
 */
function key(id: TerminalKeyId, label: string | (() => string), action: TerminalKeyAction): TerminalKey {
  return {
    id,
    get label() {
      return typeof label === 'string' ? label : label();
    },
    get ariaLabel() {
      return t(`terminal:keys.ariaLabel.${id}`);
    },
    action,
  };
}

/** Teclas que o teclado do iPhone não tem. Ordem = ordem na barra (que rola na horizontal). */
export const TERMINAL_KEYS: readonly TerminalKey[] = [
  key('esc', 'Esc', { type: 'send', data: '\x1b' }),
  key('tab', 'Tab', { type: 'send', data: '\t' }),
  key('ctrl', 'Ctrl', { type: 'sticky', key: 'ctrl' }),
  key('alt', 'Alt', { type: 'sticky', key: 'alt' }),
  key('up', '↑', { type: 'send', data: '\x1b[A' }),
  key('down', '↓', { type: 'send', data: '\x1b[B' }),
  key('left', '←', { type: 'send', data: '\x1b[D' }),
  key('right', '→', { type: 'send', data: '\x1b[C' }),
  key('pipe', '|', { type: 'send', data: '|' }),
  key('tilde', '~', { type: 'send', data: '~' }),
  key('slash', '/', { type: 'send', data: '/' }),
  key('dash', '-', { type: 'send', data: '-' }),
  key('home', 'Home', { type: 'send', data: '\x1b[H' }),
  key('end', 'End', { type: 'send', data: '\x1b[F' }),
  key('pgup', 'PgUp', { type: 'send', data: '\x1b[5~' }),
  key('pgdn', 'PgDn', { type: 'send', data: '\x1b[6~' }),
  key('paste', () => t('terminal:keys.paste.label'), { type: 'paste' }),
  key('enter', 'Enter', { type: 'send', data: '\r' }),
];
