import { describe, expect, it } from 'vitest';
import { toolImageInfo } from './toolImage.js';

describe('toolImageInfo', () => {
  it('imagem de tool call vira FileInfo com nome imagem.<ext> (o ToolContent não traz nome nem tamanho)', () => {
    expect(toolImageInfo('f-1', 'image/png')).toEqual({ fileId: 'f-1', name: 'imagem.png', mime: 'image/png', size: 0 });
  });

  it.each([
    ['image/jpeg', 'imagem.jpg'],
    ['image/gif', 'imagem.gif'],
    ['image/webp', 'imagem.webp'],
  ])('%s usa a extensão do daemon (%s)', (mime, name) => {
    expect(toolImageInfo('f-2', mime).name).toBe(name);
  });
});
