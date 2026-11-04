import { describe, expect, it } from 'vitest';
import { formatBytes, isImageMime } from './format.js';
import { canShareFiles } from './share.js';

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '2 KB'],
    [5 * 1024 * 1024, '5,0 MB'],
    [50 * 1024 * 1024, '50,0 MB'],
  ])('%i bytes vira %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe('isImageMime', () => {
  it('image/* é imagem, o resto não', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('image/jpeg')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
    expect(isImageMime('text/plain')).toBe(false);
  });
});

describe('canShareFiles', () => {
  const file = new File(['abc'], 'a.png', { type: 'image/png' });

  it('com share e canShare que aceita o arquivo, pode compartilhar', () => {
    const nav = {
      share: () => Promise.resolve(),
      canShare: (data: ShareData) => data.files?.length === 1,
    };
    expect(canShareFiles(nav, file)).toBe(true);
  });

  it('sem navigator.share (desktop, Android antigo) não pode', () => {
    expect(canShareFiles({}, file)).toBe(false);
  });

  it('canShare que recusa o tipo de arquivo não pode', () => {
    const nav = { share: () => Promise.resolve(), canShare: () => false };
    expect(canShareFiles(nav, file)).toBe(false);
  });
});
