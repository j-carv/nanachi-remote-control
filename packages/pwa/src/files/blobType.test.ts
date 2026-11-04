import { describe, expect, it } from 'vitest';
import { blobTypeOf, isInlineImageMime } from './blobType.js';

describe('isInlineImageMime', () => {
  it('só png, jpeg, gif e webp são imagem inline', () => {
    expect(isInlineImageMime('image/png')).toBe(true);
    expect(isInlineImageMime('image/jpeg')).toBe(true);
    expect(isInlineImageMime('image/gif')).toBe(true);
    expect(isInlineImageMime('image/webp')).toBe(true);
    expect(isInlineImageMime('image/svg+xml')).toBe(false);
    expect(isInlineImageMime('image/heic')).toBe(false);
    expect(isInlineImageMime('text/html')).toBe(false);
  });
});

describe('blobTypeOf', () => {
  it('raster inline mantém o tipo; o resto vira application/octet-stream (nunca text/html nem svg)', () => {
    expect(blobTypeOf('image/webp')).toBe('image/webp');
    expect(blobTypeOf('text/html')).toBe('application/octet-stream');
    expect(blobTypeOf('image/svg+xml')).toBe('application/octet-stream');
    expect(blobTypeOf('application/pdf')).toBe('application/octet-stream');
  });
});
