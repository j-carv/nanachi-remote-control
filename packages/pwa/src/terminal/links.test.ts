import { describe, expect, it } from 'vitest';
import { webLinkOf } from './links.js';

describe('webLinkOf', () => {
  it('http e https passam (normalizados)', () => {
    expect(webLinkOf('https://exemplo.com/a?b=1')).toBe('https://exemplo.com/a?b=1');
    expect(webLinkOf('HTTP://EXEMPLO.COM')).toBe('http://exemplo.com/');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'file:///C:/Users/joao/segredo.txt',
    'data:text/html,<script>alert(1)</script>',
    'ftp://exemplo.com/x',
    'blob:https://exemplo.com/uuid',
    '/caminho/relativo',
    'exemplo.com',
    '',
  ])('%s é ignorado', (text) => {
    expect(webLinkOf(text)).toBeUndefined();
  });
});
