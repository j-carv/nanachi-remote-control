/**
 * Math of the touch scroll in the terminal (no DOM here). The hook in useTerminal reads the touch events, feeds these
 * functions, and scrolls the xterm buffer with the result. xterm.js does not scroll its scrollback by touch on iOS, so
 * the app does it.
 */

/** Movimento (px) abaixo do qual o toque ainda é toque: sem rolagem, o foco e o teclado seguem a tecla normal. */
export const TAP_SLOP_PX = 8;
/** Janela (ms) das últimas amostras que definem a velocidade ao soltar. Dedo parado mais que isso não rola. */
export const FLING_WINDOW_MS = 100;
/** Duração de um quadro de rolagem (ms). A desaceleração é contada por quadro, não por tempo real. */
export const FRAME_MS = 16;
/** Fração da velocidade que sobra a cada quadro. Menor = para mais cedo. */
export const FRICTION_PER_FRAME = 0.95;
/** Velocidade (px/ms) abaixo da qual a rolagem por impulso termina. */
export const MIN_FLING_VELOCITY = 0.02;
/** Teto de velocidade (px/ms): um toque curto e forte não rola a tela inteira de uma vez. */
export const MAX_FLING_VELOCITY = 4;

export type GestureAxis = 'pending' | 'vertical' | 'horizontal';

/**
 * Eixo do gesto a partir do deslocamento total desde o início do toque. Dentro da folga (TAP_SLOP_PX nos dois eixos)
 * ainda não há decisão. Fora dela, o eixo dominante vence; empate conta como vertical.
 */
export function gestureAxis(dx: number, dy: number): GestureAxis {
  if (Math.abs(dx) < TAP_SLOP_PX && Math.abs(dy) < TAP_SLOP_PX) return 'pending';
  return Math.abs(dy) >= Math.abs(dx) ? 'vertical' : 'horizontal';
}

export interface LineStep {
  /** Linhas inteiras para `scrollLines` do xterm: negativas sobem (mostram saída mais antiga). */
  lines: number;
  /** Pixels que sobraram de menos de uma célula; somam ao próximo movimento. */
  carryPx: number;
}

/**
 * Converte um movimento do dedo (px, positivo = para baixo) em linhas. O conteúdo acompanha o dedo: arrastar para
 * baixo mostra linhas mais antigas, então o resultado é negativo. Movimento menor que uma célula não rola: o resto
 * fica em `carryPx` para o próximo movimento, e os dois lados se compensam.
 */
export function lineStep(dyPx: number, cellPx: number, carryPx: number): LineStep {
  const total = carryPx + dyPx;
  if (!(cellPx > 0)) return { lines: 0, carryPx: total };
  const whole = Math.trunc(total / cellPx);
  // `0 - whole` (e não `-whole`) para zero dar +0, e não -0.
  return { lines: 0 - whole, carryPx: total - whole * cellPx };
}

export interface TouchSample {
  /** Instante do toque (ms, mesma base de `endedAt`). */
  time: number;
  /** Posição vertical do dedo (px). */
  y: number;
}

/**
 * Velocidade (px/ms, sentido do dedo) ao soltar, a partir das amostras da última janela. Zero quando há menos de
 * duas amostras com tempo, ou quando o dedo parou antes de soltar (última amostra mais antiga que a janela).
 */
export function flingVelocity(samples: readonly TouchSample[], endedAt: number): number {
  const last = samples[samples.length - 1];
  if (last === undefined || endedAt - last.time > FLING_WINDOW_MS) return 0;
  const recent = samples.filter((sample) => last.time - sample.time <= FLING_WINDOW_MS);
  const first = recent[0];
  if (first === undefined || first === last) return 0;
  const elapsed = last.time - first.time;
  if (elapsed <= 0) return 0;
  const velocity = (last.y - first.y) / elapsed;
  return Math.max(-MAX_FLING_VELOCITY, Math.min(MAX_FLING_VELOCITY, velocity));
}

export interface FlingStep {
  /** Deslocamento (px) deste intervalo, no sentido do impulso. */
  dyPx: number;
  /** Velocidade depois do intervalo. */
  velocity: number;
}

/** Um intervalo da rolagem por impulso: anda `velocity × dt` e perde velocidade pela fricção por quadro. */
export function flingStep(velocity: number, dtMs: number): FlingStep {
  return {
    dyPx: velocity * dtMs,
    velocity: velocity * Math.pow(FRICTION_PER_FRAME, dtMs / FRAME_MS),
  };
}

/** A rolagem por impulso acabou: a velocidade ficou abaixo do limiar nos dois sentidos. */
export function isFlingOver(velocity: number): boolean {
  return Math.abs(velocity) < MIN_FLING_VELOCITY;
}
