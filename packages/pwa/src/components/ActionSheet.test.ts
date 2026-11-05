import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionSheetPanel, type ActionSheetItem } from './ActionSheet.js';

const noop = () => undefined;

const render = (items: ActionSheetItem[]): string =>
  renderToStaticMarkup(createElement(ActionSheetPanel, { title: '/model', items, onClose: noop }));

describe('ActionSheetPanel', () => {
  it('mostra o título e deixa "Cancelar" num grupo à parte, depois das ações', () => {
    const html = render([{ label: 'Rápido', onSelect: noop }]);

    expect(html).toContain('>/model</p>');
    expect(html).toContain('>Cancelar</button>');
    expect(html.indexOf('Rápido')).toBeLessThan(html.indexOf('Cancelar'));
  });

  it('marca o valor atual com aria-current e um ícone de conferido; os outros não', () => {
    const html = render([
      { label: 'Rápido', detail: 'Mais barato', checked: true, onSelect: noop },
      { label: 'Potente', checked: false, onSelect: noop },
    ]);

    expect(html).toContain('aria-current="true"');
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(html).toContain('>Mais barato</span>');
    expect(html.match(/data-check="true"/g)).toHaveLength(1);
  });

  it('tom e fonte mono saem em atributos de dados (o estilo fica no Tailwind)', () => {
    const html = render([
      { label: 'reconnect', mono: true, onSelect: noop },
      { label: 'Digitar argumentos…', tone: 'muted', onSelect: noop },
      { label: 'Remover do app', tone: 'danger', onSelect: noop },
    ]);

    expect(html).toContain('data-mono="true"');
    expect(html).toContain('data-tone="muted"');
    expect(html).toContain('data-tone="danger"');
  });

  it('rótulos repetidos não quebram a renderização', () => {
    const html = render([
      { label: 'Sem argumento', onSelect: noop },
      { label: 'Sem argumento', onSelect: noop },
    ]);

    expect(html.match(/Sem argumento/g)).toHaveLength(2);
  });
});
