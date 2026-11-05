import { describe, expect, it } from 'vitest';
import {
  FLING_WINDOW_MS,
  MAX_FLING_VELOCITY,
  MIN_FLING_VELOCITY,
  TAP_SLOP_PX,
  flingStep,
  flingVelocity,
  gestureAxis,
  isFlingOver,
  lineStep,
} from './touchScroll.js';

describe('gestureAxis: qual eixo o dedo escolheu', () => {
  it('movimento menor que a folga é toque (ainda pendente)', () => {
    expect(gestureAxis(0, 0)).toBe('pending');
    expect(gestureAxis(TAP_SLOP_PX - 1, TAP_SLOP_PX - 1)).toBe('pending');
  });

  it('arrasto mais vertical que horizontal rola na vertical', () => {
    expect(gestureAxis(2, 30)).toBe('vertical');
    expect(gestureAxis(-3, -20)).toBe('vertical');
  });

  it('arrasto mais horizontal que vertical não rola', () => {
    expect(gestureAxis(40, 10)).toBe('horizontal');
    expect(gestureAxis(-30, 12)).toBe('horizontal');
  });

  it('empate de eixo conta como vertical', () => {
    expect(gestureAxis(20, 20)).toBe('vertical');
  });
});

describe('lineStep: pixels do dedo viram linhas do xterm', () => {
  it('um passo de uma célula para baixo (dedo desce) mostra linha mais antiga: -1', () => {
    expect(lineStep(20, 20, 0)).toEqual({ lines: -1, carryPx: 0 });
  });

  it('dedo sobe uma célula: +1 (rola para o fim)', () => {
    expect(lineStep(-20, 20, 0)).toEqual({ lines: 1, carryPx: 0 });
  });

  it('movimento menor que uma célula não rola, mas fica guardado', () => {
    expect(lineStep(7, 20, 0)).toEqual({ lines: 0, carryPx: 7 });
  });

  it('o resto de um gesto soma com o próximo movimento', () => {
    const first = lineStep(15, 20, 0);
    const second = lineStep(10, 20, first.carryPx);
    expect(second).toEqual({ lines: -1, carryPx: 5 });
  });

  it('movimento para o outro lado diminui o resto guardado', () => {
    const first = lineStep(15, 20, 0);
    expect(lineStep(-10, 20, first.carryPx)).toEqual({ lines: 0, carryPx: 5 });
  });

  it('mais de uma célula de uma vez gera várias linhas', () => {
    expect(lineStep(65, 20, 0)).toEqual({ lines: -3, carryPx: 5 });
  });

  it('célula de altura zero não rola (evita divisão por zero)', () => {
    expect(lineStep(40, 0, 0)).toEqual({ lines: 0, carryPx: 40 });
  });
});

describe('flingVelocity: velocidade do dedo antes de soltar', () => {
  it('velocidade em px/ms, sentido do dedo (positivo = para baixo)', () => {
    const samples = [
      { time: 1000, y: 100 },
      { time: 1050, y: 150 },
    ];
    expect(flingVelocity(samples, 1050)).toBeCloseTo(1, 5);
    expect(flingVelocity([{ time: 1000, y: 150 }, { time: 1050, y: 100 }], 1050)).toBeCloseTo(-1, 5);
  });

  it('só conta o trecho da última janela', () => {
    const samples = [
      { time: 0, y: 0 },
      { time: 1000, y: 500 },
      { time: 1000 + FLING_WINDOW_MS, y: 500 + FLING_WINDOW_MS },
    ];
    expect(flingVelocity(samples, 1000 + FLING_WINDOW_MS)).toBeCloseTo(1, 5);
  });

  it('dedo parado antes de soltar não gera impulso', () => {
    const samples = [
      { time: 1000, y: 100 },
      { time: 1050, y: 200 },
    ];
    expect(flingVelocity(samples, 1050 + FLING_WINDOW_MS + 1)).toBe(0);
  });

  it('menos de duas amostras, ou tempo zero, dá zero', () => {
    expect(flingVelocity([], 1000)).toBe(0);
    expect(flingVelocity([{ time: 1000, y: 100 }], 1000)).toBe(0);
    expect(flingVelocity([{ time: 1000, y: 100 }, { time: 1000, y: 200 }], 1000)).toBe(0);
  });

  it('velocidade absurda é limitada', () => {
    const samples = [
      { time: 1000, y: 0 },
      { time: 1001, y: 1000 },
    ];
    expect(flingVelocity(samples, 1001)).toBe(MAX_FLING_VELOCITY);
  });
});

describe('flingStep: a rolagem continua e perde força', () => {
  it('avança velocidade × tempo e perde velocidade a cada quadro', () => {
    const step = flingStep(2, 16);
    expect(step.dyPx).toBeCloseTo(32, 5);
    expect(step.velocity).toBeCloseTo(2 * 0.95, 5);
  });

  it('a velocidade cai sempre, e a rolagem para abaixo do limiar', () => {
    let velocity = 2;
    let frames = 0;
    while (!isFlingOver(velocity) && frames < 1000) {
      const step = flingStep(velocity, 16);
      expect(Math.abs(step.velocity)).toBeLessThan(Math.abs(velocity));
      velocity = step.velocity;
      frames += 1;
    }
    expect(isFlingOver(velocity)).toBe(true);
    expect(frames).toBeGreaterThan(10);
    expect(frames).toBeLessThan(200);
  });

  it('o sentido do impulso não muda ao desacelerar', () => {
    expect(flingStep(-1, 16).velocity).toBeLessThan(0);
    expect(flingStep(-1, 16).dyPx).toBeLessThan(0);
  });

  it('limiar: abaixo de MIN_FLING_VELOCITY a rolagem acaba', () => {
    expect(isFlingOver(MIN_FLING_VELOCITY - 0.001)).toBe(true);
    expect(isFlingOver(-(MIN_FLING_VELOCITY - 0.001))).toBe(true);
    expect(isFlingOver(MIN_FLING_VELOCITY)).toBe(false);
  });
});
