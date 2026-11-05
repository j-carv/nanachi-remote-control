import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
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

describe('TERMINAL_KEYS in English', () => {
  const byId = (id: string): TerminalKey | undefined => TERMINAL_KEYS.find((key) => key.id === id);

  it('follows the language without rebuilding the list', () => {
    expect(byId('paste')?.label).toBe('Colar');
    setLanguage('en');
    expect(byId('paste')?.label).toBe('Paste');
    expect(byId('paste')?.ariaLabel).toBe('Paste from the clipboard');
    expect(byId('ctrl')?.ariaLabel).toContain('the next key');
    expect(byId('up')?.ariaLabel).toBe('Up arrow');
  });

  it('keycaps that name a key on every keyboard stay as they are', () => {
    setLanguage('en');
    expect(TERMINAL_KEYS.filter((key) => key.id !== 'paste').map((key) => key.label)).toEqual([
      'Esc', 'Tab', 'Ctrl', 'Alt', '↑', '↓', '←', '→', '|', '~', '/', '-', 'Home', 'End', 'PgUp', 'PgDn', 'Enter',
    ]);
  });

  it('every key has a non-empty accessible name in English', () => {
    setLanguage('en');
    for (const key of TERMINAL_KEYS) expect(key.ariaLabel.length).toBeGreaterThan(0);
  });
});
