import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolContent } from '@nanachi/shared';
import { createApiClient } from '../api.js';
import { OUTPUT_PREVIEW_LINES, ToolContentView } from './ToolContentView.js';

const api = createApiClient({ baseUrl: 'http://127.0.0.1:4000', token: 'test-token' });
const render = (content: ToolContent): string =>
  renderToStaticMarkup(createElement(ToolContentView, { api, content }));

describe('ToolContentView', () => {
  it('saída de texto curta aparece inteira, sem "Mostrar tudo"', () => {
    const html = render({ type: 'text', text: 'linha 1\nlinha 2' });

    expect(html).toContain('<pre');
    expect(html).toContain('linha 1\nlinha 2');
    expect(html).not.toContain('Mostrar tudo');
  });

  it('saída de texto longa corta nas primeiras linhas e oferece "Mostrar tudo"', () => {
    const lines = Array.from({ length: OUTPUT_PREVIEW_LINES + 5 }, (_, index) => `l${index}`);
    const html = render({ type: 'text', text: lines.join('\n') });

    expect(html).toContain(`Mostrar tudo (5 linhas)`);
    expect(html).toContain(`l${OUTPUT_PREVIEW_LINES - 1}`);
    expect(html).not.toContain(`l${OUTPUT_PREVIEW_LINES}<`);
  });

  it('diff mostra o caminho e uma linha por adição, remoção e contexto', () => {
    const html = render({ type: 'diff', path: 'src/a.ts', oldText: 'a\nb\n', newText: 'a\nc\n' });

    expect(html).toContain('src/a.ts');
    expect(html).toContain('data-kind="ctx"');
    expect(html).toContain('data-kind="del"');
    expect(html).toContain('data-kind="add"');
  });

  it('arquivo novo (oldText null) marca "(novo)" e só tem adições', () => {
    const html = render({ type: 'diff', path: 'novo.txt', oldText: null, newText: 'x\n' });

    expect(html).toContain('(novo)');
    expect(html).toContain('data-kind="add"');
    expect(html).not.toContain('data-kind="del"');
  });

  it('imagem começa como miniatura de carregamento (o download acontece depois do render)', () => {
    const html = render({ type: 'image', fileId: 'f1', mime: 'image/png' });

    expect(html).toContain('Carregando imagem');
  });
});
