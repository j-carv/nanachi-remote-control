import { describe, expect, it } from 'vitest';
import { TERMINAL_KEYS, type TerminalKey } from './keys.js';

function sendOf(key: TerminalKey): string | null {
  return key.action.type === 'send' ? key.action.data : null;
}

describe('TERMINAL_KEYS', () => {
  it('traz as teclas da barra na ordem do celular, com o que cada uma manda', () => {
    expect(TERMINAL_KEYS.map((key) => [key.label, sendOf(key)])).toEqual([
      ['Esc', '\x1b'],
      ['Tab', '\t'],
      ['Ctrl', null],
      ['Alt', null],
      ['↑', '\x1b[A'],
      ['↓', '\x1b[B'],
      ['←', '\x1b[D'],
      ['→', '\x1b[C'],
      ['|', '|'],
      ['~', '~'],
      ['/', '/'],
      ['-', '-'],
      ['Home', '\x1b[H'],
      ['End', '\x1b[F'],
      ['PgUp', '\x1b[5~'],
      ['PgDn', '\x1b[6~'],
      ['Colar', null],
      ['Enter', '\r'],
    ]);
  });

  it('Ctrl e Alt são travas (sticky), e Colar é ação própria', () => {
    const byId = new Map(TERMINAL_KEYS.map((key) => [key.id, key.action]));
    expect(byId.get('ctrl')).toEqual({ type: 'sticky', key: 'ctrl' });
    expect(byId.get('alt')).toEqual({ type: 'sticky', key: 'alt' });
    expect(byId.get('paste')).toEqual({ type: 'paste' });
  });

  it('ids são únicos (usados como key do React)', () => {
    const ids = TERMINAL_KEYS.map((key) => key.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('toda tecla tem nome acessível para leitor de tela, em português', () => {
    for (const key of TERMINAL_KEYS) {
      expect(key.ariaLabel.length).toBeGreaterThan(0);
    }
    expect(TERMINAL_KEYS.find((key) => key.id === 'ctrl')?.ariaLabel).toContain('próxima tecla');
  });
});
