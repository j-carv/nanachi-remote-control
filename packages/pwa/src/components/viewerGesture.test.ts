import { describe, expect, it } from 'vitest';
import { canSwipeToDismiss, isDismissDrag, isPointInside, isTapToClose, isZoomed } from './viewerGesture.js';

describe('isDismissDrag', () => {
  it('arrasto vertical para baixo além do limiar fecha', () => {
    expect(isDismissDrag(0, 120)).toBe(true);
  });

  it('arrasto curto não fecha', () => {
    expect(isDismissDrag(0, 40)).toBe(false);
  });

  it('arrasto para cima nunca fecha', () => {
    expect(isDismissDrag(0, -300)).toBe(false);
  });

  it('arrasto mais horizontal que vertical não fecha (é gesto de lado)', () => {
    expect(isDismissDrag(150, 120)).toBe(false);
  });
});

describe('isZoomed', () => {
  it('escala 1 não está ampliada, nem com a imprecisão do zoom', () => {
    expect(isZoomed(1)).toBe(false);
    expect(isZoomed(1.004)).toBe(false);
  });

  it('acima de 1 está ampliada', () => {
    expect(isZoomed(1.5)).toBe(true);
  });
});

describe('canSwipeToDismiss', () => {
  it('libera o gesto de fechar só na escala 1 com um dedo', () => {
    expect(canSwipeToDismiss(1, 1)).toBe(true);
  });

  it('ampliada, o arrasto é pan e não fecha', () => {
    expect(canSwipeToDismiss(2, 1)).toBe(false);
  });

  it('dois dedos (pinça) não fecham, mesmo na escala 1', () => {
    expect(canSwipeToDismiss(1, 2)).toBe(false);
  });
});

describe('isTapToClose', () => {
  it('toque sem arrasto na escala 1 fecha', () => {
    expect(isTapToClose(1, 0)).toBe(true);
  });

  it('toque ampliado não fecha', () => {
    expect(isTapToClose(3, 0)).toBe(false);
  });

  it('arrasto curto que termina fora da imagem não conta como toque', () => {
    expect(isTapToClose(1, 30)).toBe(false);
  });
});

describe('isPointInside', () => {
  const box = { left: 10, top: 20, right: 110, bottom: 220 };

  it('ponto no meio da caixa está dentro', () => {
    expect(isPointInside(box, 60, 120)).toBe(true);
  });

  it('bordas contam como dentro', () => {
    expect(isPointInside(box, 10, 20)).toBe(true);
    expect(isPointInside(box, 110, 220)).toBe(true);
  });

  it('ponto fora da caixa não está dentro', () => {
    expect(isPointInside(box, 5, 120)).toBe(false);
    expect(isPointInside(box, 60, 230)).toBe(false);
  });
});
