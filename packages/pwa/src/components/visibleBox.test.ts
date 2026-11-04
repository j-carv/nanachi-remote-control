import { describe, expect, it } from 'vitest';
import { visibleBox } from './visibleBox.js';

describe('visibleBox', () => {
  it('teclado fechado: sem caixa, o CSS usa 100dvh (nada de soma de safe-area)', () => {
    expect(visibleBox({ height: 844, offsetTop: 0 }, 844)).toBeNull();
  });

  it('variação pequena (barra de endereço do iOS) também não vira caixa', () => {
    expect(visibleBox({ height: 830, offsetTop: 0 }, 844)).toBeNull();
  });

  it('teclado aberto: a caixa é a área visível de verdade', () => {
    expect(visibleBox({ height: 480, offsetTop: 0 }, 844)).toEqual({ top: 0, height: 480 });
  });

  it('teclado aberto com a página deslocada: o topo acompanha o offsetTop', () => {
    expect(visibleBox({ height: 470, offsetTop: 36 }, 844)).toEqual({ top: 36, height: 470 });
  });
});
