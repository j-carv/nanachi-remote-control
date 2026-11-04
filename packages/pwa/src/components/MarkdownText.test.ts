import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownText } from './MarkdownText.js';

const render = (text: string): string => renderToStaticMarkup(createElement(MarkdownText, { text }));

describe('MarkdownText: imagens', () => {
  it('imagem remota vira link de texto e nada é carregado (sem <img>)', () => {
    const html = render('Veja ![gato](https://exemplo.com/gato.png)');

    expect(html).not.toContain('<img');
    expect(html).toContain(
      '<a href="https://exemplo.com/gato.png" rel="noopener noreferrer" target="_blank">imagem: gato</a>',
    );
  });

  it('sem texto alternativo, o rótulo é só "imagem"', () => {
    const html = render('![](https://exemplo.com/x.png)');

    expect(html).toContain('>imagem</a>');
    expect(html).not.toContain('<img');
  });

  it('src com javascript: não vira href', () => {
    const html = render('![perigo](javascript:alert(1))');

    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('imagem: perigo');
  });

  it('texto comum e links continuam como antes', () => {
    const html = render('**oi** [site](https://exemplo.com)');

    expect(html).toContain('<strong>oi</strong>');
    expect(html).toContain('<a href="https://exemplo.com"');
  });
});
