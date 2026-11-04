import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputBatcher, TERMINAL_CHUNK_BYTES } from '../src/terminal-output.js';

let flushed: string[];
let batcher: OutputBatcher;

beforeEach(() => {
  vi.useFakeTimers();
  flushed = [];
  batcher = new OutputBatcher({ onFlush: (data) => flushed.push(data) });
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number): void => {
  vi.advanceTimersByTime(ms);
};

describe('janela de tempo (50 ms)', () => {
  it('junta o que chega na janela num evento só, no fim dela', () => {
    batcher.push('a');
    advance(20);
    batcher.push('b');
    advance(29);
    expect(flushed).toEqual([]);

    advance(1);
    expect(flushed).toEqual(['ab']);
  });

  it('a janela começa no primeiro byte e não desliza a cada chegada', () => {
    batcher.push('a');
    advance(30);
    batcher.push('b');
    advance(19);
    expect(flushed).toEqual([]);

    advance(1);
    expect(flushed).toEqual(['ab']);
  });

  it('depois da descarga, a próxima janela começa no próximo byte', () => {
    batcher.push('a');
    advance(50);
    batcher.push('b');
    advance(49);
    expect(flushed).toEqual(['a']);

    advance(1);
    expect(flushed).toEqual(['a', 'b']);
  });

  it('chunk vazio não abre janela', () => {
    batcher.push('');
    advance(100);
    expect(flushed).toEqual([]);
  });
});

describe('limite de 16 KiB por evento', () => {
  it('ao passar do limite descarrega na hora um pedaço de exatamente 16 KiB e o resto na janela', () => {
    const text = 'x'.repeat(TERMINAL_CHUNK_BYTES + 10);
    batcher.push(text);
    expect(flushed).toEqual(['x'.repeat(TERMINAL_CHUNK_BYTES)]);

    advance(50);
    expect(flushed).toEqual(['x'.repeat(TERMINAL_CHUNK_BYTES), 'x'.repeat(10)]);
  });

  it('chunk de 40 KiB vira dois pedaços cheios na hora e o resto (8 KiB) na janela', () => {
    batcher.push('y'.repeat(40 * 1024));
    expect(flushed.map((piece) => piece.length)).toEqual([16384, 16384]);

    advance(50);
    expect(flushed.map((piece) => piece.length)).toEqual([16384, 16384, 8192]);
  });

  it('conta bytes UTF-8: 4096 emojis (4 bytes cada) fecham exatamente um pedaço', () => {
    const emojis = '🚀'.repeat(4096);
    batcher.push(emojis);
    expect(flushed).toEqual([emojis]);
  });

  it('nunca corta um caractere ao meio: o emoji que não cabe vai para o pedaço seguinte', () => {
    batcher.push(`${'a'.repeat(16383)}🚀`);
    expect(flushed).toEqual(['a'.repeat(16383)]);

    advance(50);
    expect(flushed).toEqual(['a'.repeat(16383), '🚀']);
  });
});

describe('UTF-8 partido entre pedaços', () => {
  it('caractere de 2 bytes cortado no meio sai inteiro, sem U+FFFD', () => {
    const bytes = Buffer.from('ação', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1;

    batcher.push(bytes.subarray(0, cut));
    advance(50);
    expect(flushed).toEqual(['a']);

    batcher.push(bytes.subarray(cut));
    advance(50);
    expect(flushed).toEqual(['a', 'ção']);
  });

  it('emoji de 4 bytes chegando um byte por vez', () => {
    for (const byte of Buffer.from('🚀', 'utf8')) {
      batcher.push(Buffer.from([byte]));
    }
    batcher.end();
    expect(flushed.join('')).toBe('🚀');
  });

  it('string já decodificada (o node-pty no Windows) passa direto', () => {
    batcher.push('ação');
    advance(50);
    expect(flushed).toEqual(['ação']);
  });
});

describe('end() (saída do processo)', () => {
  it('descarrega o pendente na hora e cancela a janela', () => {
    batcher.push('a');
    batcher.end();
    expect(flushed).toEqual(['a']);

    advance(100);
    expect(flushed).toEqual(['a']);
  });

  it('bytes incompletos no fim viram U+FFFD, como faria o TextDecoder', () => {
    batcher.push(Buffer.from([0xc3]));
    batcher.end();
    expect(flushed).toEqual(['\uFFFD']);
  });

  it('sem nada pendente não emite, e é idempotente', () => {
    batcher.end();
    batcher.end();
    expect(flushed).toEqual([]);
  });

  it('depois de end, chegadas são ignoradas', () => {
    batcher.end();
    batcher.push('tarde demais');
    advance(100);
    expect(flushed).toEqual([]);
  });
});
