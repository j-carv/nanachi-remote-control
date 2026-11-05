import type { Terminal } from '@xterm/xterm';
import {
  flingStep,
  flingVelocity,
  gestureAxis,
  isFlingOver,
  lineStep,
  type GestureAxis,
  type TouchSample,
} from './touchScroll.js';

/** Quantas amostras de toque guardar para a velocidade ao soltar (o cálculo só usa a janela recente). */
const SAMPLE_LIMIT = 16;
/** Altura de linha usada quando o xterm ainda não foi medido. */
const FALLBACK_CELL_PX = 16;

interface Gesture {
  startY: number;
  startX: number;
  lastY: number;
  axis: GestureAxis;
  /** Pixels de um movimento que ainda não chegaram a uma linha inteira. */
  carry: number;
  samples: TouchSample[];
}

/** Altura de uma linha do xterm, em px, medida agora (a tela tem `rows` linhas). */
export function cellHeightOf(container: HTMLElement, term: Terminal): number {
  const screen = container.querySelector('.xterm-screen');
  const height = screen instanceof HTMLElement ? screen.clientHeight : container.clientHeight;
  return term.rows > 0 && height > 0 ? height / term.rows : FALLBACK_CELL_PX;
}

/**
 * Rolagem por toque no xterm (o iOS não rola o histórico com o dedo). Um dedo arrastado na vertical rola o buffer;
 * ao soltar, o movimento continua com desaceleração. Com o app dentro do terminal pedindo mouse (vim, less com
 * mouse), o arrasto vira eventos de roda, que o próprio xterm codifica para o app. Toque sem movimento não é
 * capturado: o clique segue e o terminal ganha foco (o teclado abre). Arrasto na horizontal não rola.
 *
 * Os ouvintes ficam na fase de captura do próprio elemento do terminal. Quando o gesto é vertical, o evento para
 * ali, e o tratamento de toque do xterm (que rola a viewport interna) não roda junto. Retorna a função que remove
 * os ouvintes e para a desaceleração.
 */
export function attachTouchScroll(target: HTMLElement, term: Terminal, cellHeight: () => number): () => void {
  let gesture: Gesture | undefined;
  let frame: number | undefined;

  function stopFling(): void {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }

  /** Roda o conteúdo em `lines` linhas: negativo sobe (saída mais antiga). */
  function scrollBy(lines: number): void {
    if (lines === 0) return;
    if (term.modes.mouseTrackingMode !== 'none') {
      wheelTo(lines);
      return;
    }
    term.scrollLines(lines);
  }

  /** Um evento de roda por linha, no elemento de tela: o xterm codifica do jeito que o app pediu. */
  function wheelTo(lines: number): void {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!(screen instanceof HTMLElement)) return;
    const deltaY = lines < 0 ? -1 : 1;
    for (let count = 0; count < Math.abs(lines); count += 1) {
      screen.dispatchEvent(
        new WheelEvent('wheel', { deltaY, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true }),
      );
    }
  }

  function fling(initialVelocity: number): void {
    let velocity = initialVelocity;
    let previous = performance.now();
    let carry = 0;
    const tick = (now: number): void => {
      const step = flingStep(velocity, now - previous);
      previous = now;
      const line = lineStep(step.dyPx, cellHeight(), carry);
      carry = line.carryPx;
      scrollBy(line.lines);
      velocity = step.velocity;
      frame = isFlingOver(velocity) ? undefined : requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  const onStart = (event: TouchEvent): void => {
    stopFling();
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    if (touch === undefined) {
      gesture = undefined;
      return;
    }
    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastY: touch.clientY,
      axis: 'pending',
      carry: 0,
      samples: [{ time: event.timeStamp, y: touch.clientY }],
    };
  };

  const onMove = (event: TouchEvent): void => {
    const current = gesture;
    if (current === undefined) return;
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    if (touch === undefined) {
      gesture = undefined;
      return;
    }
    if (current.axis === 'pending') {
      current.axis = gestureAxis(touch.clientX - current.startX, touch.clientY - current.startY);
      if (current.axis === 'pending') return;
      // A rolagem começa de onde o dedo tocou: o primeiro movimento vale desde o início do gesto.
      current.lastY = current.startY;
    }
    if (current.axis !== 'vertical') return;

    event.preventDefault();
    event.stopPropagation();
    const dy = touch.clientY - current.lastY;
    current.lastY = touch.clientY;
    current.samples.push({ time: event.timeStamp, y: touch.clientY });
    if (current.samples.length > SAMPLE_LIMIT) current.samples.splice(0, current.samples.length - SAMPLE_LIMIT);
    const line = lineStep(dy, cellHeight(), current.carry);
    current.carry = line.carryPx;
    scrollBy(line.lines);
  };

  const onEnd = (event: TouchEvent): void => {
    const current = gesture;
    gesture = undefined;
    if (current === undefined || current.axis !== 'vertical') return;
    const velocity = flingVelocity(current.samples, event.timeStamp);
    if (!isFlingOver(velocity)) fling(velocity);
  };

  const onCancel = (): void => {
    gesture = undefined;
    stopFling();
  };

  const capture = { capture: true } as const;
  target.addEventListener('touchstart', onStart, { ...capture, passive: true });
  target.addEventListener('touchmove', onMove, { ...capture, passive: false });
  target.addEventListener('touchend', onEnd, { ...capture, passive: true });
  target.addEventListener('touchcancel', onCancel, { ...capture, passive: true });

  return () => {
    target.removeEventListener('touchstart', onStart, capture);
    target.removeEventListener('touchmove', onMove, capture);
    target.removeEventListener('touchend', onEnd, capture);
    target.removeEventListener('touchcancel', onCancel, capture);
    gesture = undefined;
    stopFling();
  };
}
