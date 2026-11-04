import { describe, expect, it } from 'vitest';
import { clipList, clipText } from './clipLines.js';

describe('clipList', () => {
  it('corta na quantidade máxima e conta o que ficou de fora', () => {
    expect(clipList([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], hidden: 2 });
  });

  it('lista menor que o limite não corta', () => {
    expect(clipList([1], 5)).toEqual({ shown: [1], hidden: 0 });
  });
});

describe('clipText', () => {
  it('mostra só as primeiras linhas e conta o resto', () => {
    expect(clipText('a\nb\nc', 2)).toEqual({ text: 'a\nb', hidden: 1 });
  });

  it('texto curto volta inteiro', () => {
    expect(clipText('a\nb', 5)).toEqual({ text: 'a\nb', hidden: 0 });
  });

  it('texto vazio tem zero linhas', () => {
    expect(clipText('', 3)).toEqual({ text: '', hidden: 0 });
  });
});
