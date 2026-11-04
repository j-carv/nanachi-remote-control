import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESIZE_DEBOUNCE_MS, createResizeScheduler, sameSize, type TerminalSize } from './resize.js';

describe('sameSize', () => {
  it('compara cols e rows', () => {
    expect(sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(sameSize({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(false);
    expect(sameSize({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false);
  });

  it('nada enviado ainda não é igual a nenhum tamanho', () => {
    expect(sameSize(null, { cols: 80, rows: 24 })).toBe(false);
  });
});

describe('createResizeScheduler com canSend', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('não envia enquanto canSend for falso (terminal encerrado) e envia quando virar verdadeiro', () => {
    vi.useFakeTimers();
    let live = false;
    const sent: TerminalSize[] = [];
    const scheduler = createResizeScheduler({
      delayMs: RESIZE_DEBOUNCE_MS,
      measure: () => ({ cols: 80, rows: 24 }),
      send: (next) => {
        sent.push(next);
        return true;
      },
      canSend: () => live,
    });

    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(sent).toEqual([]);

    live = true;
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
    scheduler.dispose();
  });
});

describe('createResizeScheduler', () => {
  let size: TerminalSize;
  let measured: number;
  let sent: TerminalSize[];
  let accept: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    size = { cols: 80, rows: 24 };
    measured = 0;
    sent = [];
    accept = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function create() {
    return createResizeScheduler({
      delayMs: RESIZE_DEBOUNCE_MS,
      measure: () => {
        measured += 1;
        return size;
      },
      send: (next) => {
        sent.push(next);
        return accept;
      },
    });
  }

  it('o debounce padrão é 150 ms', () => {
    expect(RESIZE_DEBOUNCE_MS).toBe(150);
  });

  it('não mede nem envia antes do atraso', () => {
    const scheduler = create();
    scheduler.request();
    vi.advanceTimersByTime(149);
    expect(measured).toBe(0);
    expect(sent).toEqual([]);
    scheduler.dispose();
  });

  it('vários pedidos dentro da janela viram um só, medido no fim', () => {
    const scheduler = create();
    scheduler.request();
    vi.advanceTimersByTime(100);
    scheduler.request();
    vi.advanceTimersByTime(100);
    scheduler.request();
    vi.advanceTimersByTime(149);
    expect(measured).toBe(0);
    vi.advanceTimersByTime(1);
    expect(measured).toBe(1);
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
    scheduler.dispose();
  });

  it('primeiro tamanho sempre é enviado', () => {
    const scheduler = create();
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(sent).toEqual([{ cols: 80, rows: 24 }]);
    scheduler.dispose();
  });

  it('tamanho igual ao último enviado não manda de novo', () => {
    const scheduler = create();
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(measured).toBe(2);
    expect(sent).toHaveLength(1);
    scheduler.dispose();
  });

  it('mudança de cols ou rows envia o novo tamanho', () => {
    const scheduler = create();
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    size = { cols: 80, rows: 16 };
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(sent).toEqual([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 16 },
    ]);
    scheduler.dispose();
  });

  it('envio recusado (offline) não conta como enviado: o próximo pedido tenta de novo', () => {
    const scheduler = create();
    accept = false;
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    accept = true;
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(sent).toEqual([
      { cols: 80, rows: 24 },
      { cols: 80, rows: 24 },
    ]);
    scheduler.dispose();
  });

  it('forget esquece o último envio: o mesmo tamanho é reenviado (ex.: após reconectar)', () => {
    const scheduler = create();
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    scheduler.forget();
    scheduler.request();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS);
    expect(sent).toHaveLength(2);
    scheduler.dispose();
  });

  it('dispose cancela o pedido pendente', () => {
    const scheduler = create();
    scheduler.request();
    scheduler.dispose();
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS * 2);
    expect(measured).toBe(0);
    expect(sent).toEqual([]);
  });
});
