import { describe, expect, it } from 'vitest';
import { NO_STICKY_KEYS, applySticky, hasSticky, isUserKey } from './modifiers.js';

describe('applySticky', () => {
  it('sem modificador ativo, a entrada passa sem mudança', () => {
    expect(applySticky('ls\r', NO_STICKY_KEYS)).toBe('ls\r');
    expect(applySticky('\x1b[A', NO_STICKY_KEYS)).toBe('\x1b[A');
  });

  it('Ctrl transforma a letra em caractere de controle', () => {
    expect(applySticky('c', { ctrl: true, alt: false })).toBe('\x03');
    expect(applySticky('C', { ctrl: true, alt: false })).toBe('\x03');
    expect(applySticky('d', { ctrl: true, alt: false })).toBe('\x04');
    expect(applySticky('z', { ctrl: true, alt: false })).toBe('\x1a');
  });

  it('Ctrl com símbolos da faixa de controle (@ [ \ ] ^ _)', () => {
    expect(applySticky('[', { ctrl: true, alt: false })).toBe('\x1b');
    expect(applySticky('_', { ctrl: true, alt: false })).toBe('\x1f');
  });

  it('Ctrl só altera o primeiro caractere de um trecho', () => {
    expect(applySticky('cd\r', { ctrl: true, alt: false })).toBe('\x03d\r');
  });

  it('Ctrl não altera dígitos nem sequências de escape (setas)', () => {
    expect(applySticky('1', { ctrl: true, alt: false })).toBe('1');
    expect(applySticky('\x1b[A', { ctrl: true, alt: false })).toBe('\x1b[A');
    expect(applySticky('\r', { ctrl: true, alt: false })).toBe('\r');
  });

  it('Alt põe ESC na frente da entrada', () => {
    expect(applySticky('b', { ctrl: false, alt: true })).toBe('\x1bb');
    expect(applySticky('\x1b[D', { ctrl: false, alt: true })).toBe('\x1b\x1b[D');
  });

  it('Ctrl e Alt juntos: controle primeiro, depois ESC', () => {
    expect(applySticky('x', { ctrl: true, alt: true })).toBe('\x1b\x18');
  });

  it('entrada vazia continua vazia', () => {
    expect(applySticky('', { ctrl: true, alt: true })).toBe('');
  });
});

describe('hasSticky', () => {
  it('diz se algum modificador está ligado', () => {
    expect(hasSticky(NO_STICKY_KEYS)).toBe(false);
    expect(hasSticky({ ctrl: true, alt: false })).toBe(true);
    expect(hasSticky({ ctrl: false, alt: true })).toBe(true);
  });
});

describe('isUserKey', () => {
  it('relatório de foco do xterm (entrou/saiu) não é tecla do usuário e não gasta a trava', () => {
    expect(isUserKey('\x1b[I')).toBe(false);
    expect(isUserKey('\x1b[O')).toBe(false);
  });

  it('tecla, seta e texto colado são teclas do usuário', () => {
    expect(isUserKey('c')).toBe(true);
    expect(isUserKey('\x1b[A')).toBe(true);
    expect(isUserKey('\r')).toBe(true);
  });
});
