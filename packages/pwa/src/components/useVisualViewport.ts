import { useEffect, useState } from 'react';
import { visibleBox, type ViewportBox } from './visibleBox.js';

export type { ViewportBox } from './visibleBox.js';

/**
 * Área visível quando o teclado está aberto (o `visualViewport` encolhe e o `100dvh` não). Com o teclado
 * fechado, devolve null e o CSS usa 100dvh.
 */
export function useVisualViewport(): ViewportBox | null {
  const [box, setBox] = useState<ViewportBox | null>(null);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => setBox(visibleBox(viewport, window.innerHeight));
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  return box;
}
