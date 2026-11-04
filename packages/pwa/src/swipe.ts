/** Largura da ação revelada pelo swipe para a esquerda (px). Alvo de toque mínimo: 44px. */
export const SWIPE_ACTION_WIDTH = 96;

/** Movimento mínimo (px) para decidir se o gesto é horizontal ou vertical. */
const DECIDE_PX = 8;

/** Deslocamento do conteúdo para um arrasto de `dragX` px: só para a esquerda, até a largura da ação. */
export function swipeOffset(dragX: number, actionWidth: number): number {
  return Math.max(-actionWidth, Math.min(0, dragX));
}

/** Ao soltar: fica aberto se passou da metade da ação. */
export function settleSwipe(offset: number, actionWidth: number): boolean {
  return offset <= -actionWidth / 2;
}

/**
 * Eixo do gesto a partir do deslocamento acumulado. Vertical deixa a lista rolar; horizontal age no swipe.
 * Undefined enquanto o movimento ainda é pequeno.
 */
export function classifySwipe(dx: number, dy: number): 'horizontal' | 'vertical' | undefined {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (Math.max(ax, ay) < DECIDE_PX) return undefined;
  return ax > ay ? 'horizontal' : 'vertical';
}
