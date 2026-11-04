import { describe, expect, it } from 'vitest';
import { TERMINAL_KEYS } from './keys.js';

describe('TERMINAL_KEYS', () => {
  it('traz as teclas da barra na ordem do celular, com a sequência de cada uma', () => {
    expect(TERMINAL_KEYS.map((key) => [key.label, key.data])).toEqual([
      ['Esc', '\x1b'],
      ['Tab', '\t'],
      ['Ctrl+C', '\x03'],
      ['Ctrl+D', '\x04'],
      ['↑', '\x1b[A'],
      ['↓', '\x1b[B'],
      ['→', '\x1b[C'],
      ['←', '\x1b[D'],
      ['Enter', '\r'],
    ]);
  });

  it('ids são únicos (usados como key do React)', () => {
    const ids = TERMINAL_KEYS.map((key) => key.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('toda tecla tem nome acessível para leitor de tela', () => {
    for (const key of TERMINAL_KEYS) {
      expect(key.ariaLabel.length).toBeGreaterThan(0);
    }
  });
});
