import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from './markdownBlocks.js';

describe('splitMarkdownBlocks', () => {
  it('separa parágrafos pela linha em branco', () => {
    expect(splitMarkdownBlocks('a\n\nb')).toEqual(['a', 'b']);
  });

  it('texto sem linha em branco vira um bloco só', () => {
    expect(splitMarkdownBlocks('linha 1\nlinha 2')).toEqual(['linha 1\nlinha 2']);
  });

  it('bloco de código com linha em branco dentro fica inteiro', () => {
    expect(splitMarkdownBlocks('```ts\nx\n\ny\n```\n\nz')).toEqual(['```ts\nx\n\ny\n```', 'z']);
  });

  it('cerca com til também protege o conteúdo', () => {
    expect(splitMarkdownBlocks('~~~\na\n\nb\n~~~')).toEqual(['~~~\na\n\nb\n~~~']);
  });

  it('texto vazio não gera blocos', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('\n\n\n')).toEqual([]);
  });
});
