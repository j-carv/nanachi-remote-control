import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../machines.js';
import {
  DEFAULT_FONT_SIZE,
  FONT_SIZE_KEY,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  clampFontSize,
  readFontSize,
  writeFontSize,
} from './fontSize.js';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe('clampFontSize', () => {
  it('mantém o tamanho dentro dos limites', () => {
    expect(clampFontSize(MIN_FONT_SIZE - 5)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(MAX_FONT_SIZE + 5)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(14)).toBe(14);
  });

  it('arredonda para inteiro', () => {
    expect(clampFontSize(13.4)).toBe(13);
  });

  it('valor que não é número finito volta ao padrão', () => {
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FONT_SIZE);
  });
});

describe('readFontSize / writeFontSize', () => {
  it('sem valor salvo, usa o padrão', () => {
    expect(readFontSize(memoryStorage())).toBe(DEFAULT_FONT_SIZE);
  });

  it('grava e lê na chave própria, por aparelho', () => {
    const storage = memoryStorage();
    writeFontSize(storage, 16);
    expect(storage.data.get(FONT_SIZE_KEY)).toBe('16');
    expect(readFontSize(storage)).toBe(16);
  });

  it('valor salvo inválido ou fora da faixa é corrigido na leitura', () => {
    expect(readFontSize(memoryStorage({ [FONT_SIZE_KEY]: 'abc' }))).toBe(DEFAULT_FONT_SIZE);
    expect(readFontSize(memoryStorage({ [FONT_SIZE_KEY]: '99' }))).toBe(MAX_FONT_SIZE);
  });

  it('storage que lança não quebra leitura nem escrita', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(readFontSize(broken)).toBe(DEFAULT_FONT_SIZE);
    expect(() => writeFontSize(broken, 12)).not.toThrow();
  });
});
