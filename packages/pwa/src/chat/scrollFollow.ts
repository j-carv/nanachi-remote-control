/** Tolerância (px) para considerar que o usuário está no fim da conversa. */
export const BOTTOM_TOLERANCE_PX = 80;

/** Quantos itens a conversa mostra ao abrir, e quantos entram a cada "Carregar anteriores". */
export const WINDOW_INITIAL = 40;
export const WINDOW_STEP = 30;

/** Dentro da tolerância, a rolagem acompanha o conteúdo novo. */
export function isNearBottom(distanceToBottomPx: number): boolean {
  return distanceToBottomPx <= BOTTOM_TOLERANCE_PX;
}

/** Itens que chegaram desde que o usuário saiu do fim (contagem do botão "Ir para o fim"). */
export function unseenSince(baseline: number, current: number): number {
  return Math.max(0, current - baseline);
}

/** Primeiro índice renderizado ao abrir a conversa: só os últimos `size` itens. */
export function initialFloor(total: number, size: number): number {
  return Math.max(0, total - size);
}

/** Primeiro índice renderizado depois de carregar `step` itens anteriores. */
export function earlierFloor(floor: number, step: number): number {
  return Math.max(0, floor - step);
}
