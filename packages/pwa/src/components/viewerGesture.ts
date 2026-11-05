/** Distância (px) para baixo que fecha o visualizador ao soltar o dedo. */
export const DISMISS_DRAG_PX = 96;

/** Deslocamento (px) acima do qual um toque vira arrasto e não fecha o visualizador ao soltar. */
export const TAP_SLOP_PX = 8;

/** Escala de repouso: a imagem cabe na tela. Swipe e toque-para-fechar só valem aqui. */
const FIT_SCALE = 1;
/** Tolerância para o zoom devolver 1.00x com arredondamento. */
const SCALE_EPSILON = 0.01;

/** Arrasto para baixo, vertical e além do limiar: fecha. Abaixo disso a imagem volta ao lugar. */
export function isDismissDrag(dx: number, dy: number): boolean {
  return dy >= DISMISS_DRAG_PX && Math.abs(dx) < dy / 2;
}

/** A imagem está ampliada: o arrasto vira pan, não gesto de fechar. */
export function isZoomed(scale: number): boolean {
  return scale > FIT_SCALE + SCALE_EPSILON;
}

/** Arrasto para fechar só na escala de repouso e com um dedo; com dois (pinça) o zoom é que age. */
export function canSwipeToDismiss(scale: number, pointerCount: number): boolean {
  return !isZoomed(scale) && pointerCount === 1;
}

/** Toque na área fora da imagem fecha, mas só na escala de repouso e sem ter virado arrasto. */
export function isTapToClose(scale: number, travelPx: number): boolean {
  return !isZoomed(scale) && travelPx < TAP_SLOP_PX;
}

/** Caixa em coordenadas de tela (DOMRect serve). */
export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Ponto dentro da caixa, bordas incluídas. Serve para ver se o toque caiu na foto: a biblioteca de zoom desliga o
 * ponteiro da imagem (pointer-events: none), então o alvo do clique é o contêiner, não a foto.
 */
export function isPointInside(box: ScreenBox, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}
