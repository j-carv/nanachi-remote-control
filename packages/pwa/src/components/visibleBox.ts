export interface ViewportBox {
  top: number;
  height: number;
}

/** Diferença mínima (px) entre a janela e a área visível para contar como teclado aberto. */
const KEYBOARD_MIN_PX = 120;

/**
 * Caixa da área visível só com o teclado aberto. Com o teclado fechado devolve null, e o CSS usa 100dvh:
 * somar offset do visualViewport nesse caso deixa o composer flutuando acima da borda da tela no iPhone.
 */
export function visibleBox(viewport: { height: number; offsetTop: number }, windowHeight: number): ViewportBox | null {
  if (windowHeight - viewport.height < KEYBOARD_MIN_PX) return null;
  return { top: viewport.offsetTop, height: viewport.height };
}
