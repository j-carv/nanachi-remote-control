import { describe, expect, it } from 'vitest';
import { earlierFloor, initialFloor, isNearBottom, unseenSince } from './scrollFollow.js';

describe('isNearBottom', () => {
  it('dentro da tolerância conta como fim da conversa', () => {
    expect(isNearBottom(0)).toBe(true);
    expect(isNearBottom(80)).toBe(true);
  });

  it('acima da tolerância não conta como fim', () => {
    expect(isNearBottom(81)).toBe(false);
  });
});

describe('unseenSince', () => {
  it('conta só os itens que chegaram depois de sair do fim', () => {
    expect(unseenSince(5, 8)).toBe(3);
  });

  it('nunca fica negativo (lista encolheu)', () => {
    expect(unseenSince(8, 5)).toBe(0);
  });
});

describe('janela de itens', () => {
  it('abre mostrando só os últimos itens', () => {
    expect(initialFloor(100, 40)).toBe(60);
  });

  it('lista curta começa do primeiro item', () => {
    expect(initialFloor(10, 40)).toBe(0);
  });

  it('carregar anteriores sobe o início em passos e para no zero', () => {
    expect(earlierFloor(60, 30)).toBe(30);
    expect(earlierFloor(10, 30)).toBe(0);
    expect(earlierFloor(0, 30)).toBe(0);
  });
});
