import { describe, expect, it } from 'vitest';
import { classifySwipe, settleSwipe, swipeOffset, SWIPE_ACTION_WIDTH } from './swipe.js';

describe('swipeOffset', () => {
  it('acompanha o dedo para a esquerda e não passa da largura da ação', () => {
    expect(swipeOffset(-40, SWIPE_ACTION_WIDTH)).toBe(-40);
    expect(swipeOffset(-500, SWIPE_ACTION_WIDTH)).toBe(-SWIPE_ACTION_WIDTH);
  });

  it('não vai para a direita além da posição fechada', () => {
    expect(swipeOffset(30, SWIPE_ACTION_WIDTH)).toBe(0);
    expect(swipeOffset(0, SWIPE_ACTION_WIDTH)).toBe(0);
  });

  it('a ação é alvo de toque de pelo menos 44px de largura', () => {
    expect(SWIPE_ACTION_WIDTH).toBeGreaterThanOrEqual(44);
  });
});

describe('settleSwipe', () => {
  it('abre quando passou da metade da ação', () => {
    expect(settleSwipe(-SWIPE_ACTION_WIDTH / 2, SWIPE_ACTION_WIDTH)).toBe(true);
    expect(settleSwipe(-SWIPE_ACTION_WIDTH, SWIPE_ACTION_WIDTH)).toBe(true);
  });

  it('fecha quando não chegou à metade', () => {
    expect(settleSwipe(-SWIPE_ACTION_WIDTH / 2 + 1, SWIPE_ACTION_WIDTH)).toBe(false);
    expect(settleSwipe(0, SWIPE_ACTION_WIDTH)).toBe(false);
  });
});

describe('classifySwipe', () => {
  it('é horizontal quando o movimento passa de 8px e predomina em x', () => {
    expect(classifySwipe(-20, 4)).toBe('horizontal');
  });

  it('é vertical quando predomina em y (a lista rola, o swipe não age)', () => {
    expect(classifySwipe(-6, 30)).toBe('vertical');
  });

  it('ainda não decidiu antes de 8px de movimento', () => {
    expect(classifySwipe(-5, 2)).toBeUndefined();
  });
});
