import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SessionConfigOption } from '@nanachi/shared';
import { ConfigControls, ConfigSelect } from './ConfigControls.js';

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>;

const modelOption = (options: SelectOption['options'], currentValue: string): SelectOption => ({
  id: 'model',
  name: 'Modelo',
  description: null,
  category: 'model',
  type: 'select',
  currentValue,
  options,
});

const OMP_MODELS = modelOption(
  [
    { value: 'cursor/claude-4.5-sonnet', name: 'Claude 4.5 Sonnet' },
    { value: 'claude-cli/opus', name: 'Opus' },
    { value: 'openrouter/~anthropic/claude-opus-latest', name: 'Claude Opus latest' },
  ],
  'openrouter/~anthropic/claude-opus-latest',
);

const noop = () => undefined;

const renderSelect = (option: SelectOption): string =>
  renderToStaticMarkup(createElement(ConfigSelect, { label: 'Modelo', option, onChange: noop }));

const renderControls = (option: SelectOption): string =>
  renderToStaticMarkup(createElement(ConfigControls, { options: [option], onChange: noop }));

interface RenderedOption {
  value: string;
  text: string;
  selected: boolean;
}

interface RenderedGroup {
  label: string | null;
  options: RenderedOption[];
}

interface RenderedSelect {
  openTag: string;
  groups: RenderedGroup[];
}

/** The `<select>` of the markup: its opening tag and its options, in order, grouped by `<optgroup>` (null = no group). */
function parseSelect(html: string): RenderedSelect {
  const match = /<select([^>]*)>([\s\S]*?)<\/select>/.exec(html);
  if (match === null) throw new Error('no <select> in the markup');
  const groups: RenderedGroup[] = [];
  let current: RenderedGroup | null = null;
  for (const token of (match[2] ?? '').matchAll(/<optgroup label="([^"]*)">|<\/optgroup>|<option([^>]*)>([^<]*)<\/option>/g)) {
    if (token[1] !== undefined) {
      current = { label: token[1], options: [] };
      groups.push(current);
    } else if (token[0] === '</optgroup>') {
      current = null;
    } else {
      if (current === null) {
        current = { label: null, options: [] };
        groups.push(current);
      }
      const attrs = token[2] ?? '';
      current.options.push({
        value: /value="([^"]*)"/.exec(attrs)?.[1] ?? '',
        text: token[3] ?? '',
        selected: / selected(=|\s|$)/.test(attrs),
      });
    }
  }
  return { openTag: match[1] ?? '', groups };
}

const attributeOf = (openTag: string, name: string): string | undefined =>
  new RegExp(`${name}="([^"]*)"`).exec(openTag)?.[1];

/** The span with the given id: its opening tag and its text. */
function spanWithId(html: string, id: string): { openTag: string; text: string } {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) throw new Error(`no element with id ${id}`);
  const start = html.lastIndexOf('<span', at);
  const end = html.indexOf('</span>', at);
  const tag = html.slice(start, end);
  return { openTag: tag.slice(0, tag.indexOf('>') + 1), text: tag.slice(tag.indexOf('>') + 1) };
}

describe('ConfigSelect', () => {
  it('lista um optgroup por provedor e mostra o provedor embaixo do modelo atual', () => {
    const html = renderSelect(OMP_MODELS);

    expect(html).toContain('<optgroup label="Cursor">');
    expect(html).toContain('<optgroup label="Claude CLI">');
    expect(html).toContain('<optgroup label="OpenRouter">');
    expect(html).toContain('Claude Opus latest · Anthropic</option>');
    expect(html).toContain('>OpenRouter · Anthropic</span>');
    expect(html).toContain('data-slot="config-select"');
    expect(html).toContain('data-option="model"');
    expect(html).toContain('opacity-0');
  });

  it('o select leva o valor atual e a ordem dos optgroups e das opções segue o primeiro aparecimento', () => {
    const interleaved = modelOption(
      [
        { value: 'cursor/a', name: 'A' },
        { value: 'claude-cli/b', name: 'B' },
        { value: 'cursor/c', name: 'C' },
        { value: 'openrouter/~anthropic/d', name: 'D' },
        { value: 'claude-cli/e', name: 'E' },
        { value: 'default', name: 'Padrão' },
      ],
      'cursor/c',
    );

    const { groups } = parseSelect(renderSelect(interleaved));

    expect(groups.map((group) => [group.label, group.options.map((option) => option.value)])).toEqual([
      ['Cursor', ['cursor/a', 'cursor/c']],
      ['Claude CLI', ['claude-cli/b', 'claude-cli/e']],
      ['OpenRouter', ['openrouter/~anthropic/d']],
      ['Outros', ['default']],
    ]);
    const selected = groups.flatMap((group) => group.options).filter((option) => option.selected);
    expect(selected.map((option) => option.value)).toEqual(['cursor/c']);
  });

  it('o texto das opções leva o fornecedor do OpenRouter e nada mais', () => {
    const { groups } = parseSelect(renderSelect(OMP_MODELS));

    expect(groups.flatMap((group) => group.options.map((option) => option.text))).toEqual([
      'Claude 4.5 Sonnet',
      'Opus',
      'Claude Opus latest · Anthropic',
    ]);
  });

  it('nomes iguais em provedores diferentes ficam em optgroups distintos, e a linha do provedor diz qual está escolhido', () => {
    const duplicated = modelOption(
      [
        { value: 'cursor/claude-opus-5.5', name: 'Claude Opus 5.5' },
        { value: 'claude-cli/claude-opus-5.5', name: 'Claude Opus 5.5' },
      ],
      'claude-cli/claude-opus-5.5',
    );
    const html = renderSelect(duplicated);
    const { groups, openTag } = parseSelect(html);

    expect(groups.map((group) => [group.label, group.options.map((option) => option.text)])).toEqual([
      ['Cursor', ['Claude Opus 5.5']],
      ['Claude CLI', ['Claude Opus 5.5']],
    ]);
    expect(groups[1]?.options[0]?.selected).toBe(true);
    expect(groups[0]?.options[0]?.selected).toBe(false);

    const describedBy = attributeOf(openTag, 'aria-describedby');
    expect(describedBy).toBeDefined();
    const provider = spanWithId(html, describedBy ?? '');
    expect(provider.text).toBe('Claude CLI');
    expect(provider.openTag).not.toContain('aria-hidden');
  });

  it('expõe o provedor ao leitor de tela: select nomeado pelo rótulo e descrito pela linha do provedor', () => {
    const html = renderSelect(OMP_MODELS);
    const { openTag } = parseSelect(html);

    expect(attributeOf(openTag, 'aria-label')).toBe('Modelo');
    const provider = spanWithId(html, attributeOf(openTag, 'aria-describedby') ?? '');
    expect(provider.text).toBe('OpenRouter · Anthropic');
    expect(provider.openTag).not.toContain('aria-hidden');
    // The name line repeats the select's own value, so only that line is hidden from screen readers.
    expect(html).toContain('<span aria-hidden="true" class="block truncate text-base text-foreground">Claude Opus latest</span>');
  });

  it('mantém a área de toque de 44 px e o anel de foco só para foco de teclado', () => {
    const html = renderSelect(OMP_MODELS);
    const wrapper = /<span class="([^"]*max-w-\[62%\][^"]*)"/.exec(html)?.[1] ?? '';

    expect(wrapper.split(/\s+/)).toContain('min-h-11');
    expect(wrapper).toContain('has-[select:focus-visible]:ring-2');
    expect(wrapper).not.toContain('focus-within');
  });

  it('modelo atual sem provedor: sem linha do provedor, sem aria-describedby, e a área de toque continua a mesma', () => {
    const withDefault = modelOption(
      [
        { value: 'cursor/a', name: 'A' },
        { value: 'claude-cli/b', name: 'B' },
        { value: 'default', name: 'Padrão' },
      ],
      'default',
    );
    const html = renderSelect(withDefault);
    const { openTag, groups } = parseSelect(html);

    expect(groups.at(-1)).toEqual({
      label: 'Outros',
      options: [{ value: 'default', text: 'Padrão', selected: true }],
    });
    expect(openTag).not.toContain('aria-describedby');
    expect(html).not.toContain('text-sm text-muted-foreground');
    expect(html).toContain('min-h-11');
  });

  it('opções de grupo ACP: a linha do provedor é o nome do grupo e o texto da opção não leva fornecedor', () => {
    const acpGrouped = modelOption(
      [
        { value: 'openrouter/~anthropic/x', name: 'X', group: 'Alpha' },
        { value: 'cursor/y', name: 'Y', group: 'Beta' },
      ],
      'openrouter/~anthropic/x',
    );
    const html = renderSelect(acpGrouped);
    const { groups, openTag } = parseSelect(html);

    expect(groups.map((group) => [group.label, group.options.map((option) => option.text)])).toEqual([
      ['Alpha', ['X']],
      ['Beta', ['Y']],
    ]);
    expect(spanWithId(html, attributeOf(openTag, 'aria-describedby') ?? '').text).toBe('Alpha');
  });

  it('com lista de um provedor (ou sem provedor) renderiza como antes: select visível, sem optgroup', () => {
    const single = modelOption(
      [
        { value: 'default', name: 'Padrão' },
        { value: 'opus', name: 'Opus' },
      ],
      'opus',
    );
    const html = renderSelect(single);
    const { openTag, groups } = parseSelect(html);

    expect(html).not.toContain('optgroup');
    expect(html).not.toContain('opacity-0');
    expect(html).toContain('>Padrão</option>');
    expect(openTag).not.toContain('aria-describedby');
    expect(openTag).not.toContain('aria-label');
    expect(groups).toEqual([
      {
        label: null,
        options: [
          { value: 'default', text: 'Padrão', selected: false },
          { value: 'opus', text: 'Opus', selected: true },
        ],
      },
    ]);
  });
});

describe('ConfigControls', () => {
  it('o select de modelo com vários provedores usa optgroup também na lista de opções', () => {
    const html = renderControls(OMP_MODELS);

    expect(html).toContain('<optgroup label="Cursor">');
    expect(html).toContain('Claude 4.5 Sonnet</option>');
    expect(html).toContain('>OpenRouter · Anthropic</span>');
  });

  it('o select leva o valor atual e a ordem dos optgroups e das opções', () => {
    const { groups } = parseSelect(renderControls(OMP_MODELS));

    expect(groups.map((group) => [group.label, group.options.map((option) => option.value)])).toEqual([
      ['Cursor', ['cursor/claude-4.5-sonnet']],
      ['Claude CLI', ['claude-cli/opus']],
      ['OpenRouter', ['openrouter/~anthropic/claude-opus-latest']],
    ]);
    expect(groups.flatMap((group) => group.options).filter((option) => option.selected).map((option) => option.value)).toEqual([
      'openrouter/~anthropic/claude-opus-latest',
    ]);
  });

  it('expõe o provedor e a descrição ao leitor de tela e esconde só a linha do nome', () => {
    const html = renderControls({ ...OMP_MODELS, description: 'Modelo da sessão' });
    const { openTag } = parseSelect(html);

    expect(attributeOf(openTag, 'aria-label')).toBe('Modelo');
    const ids = (attributeOf(openTag, 'aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    expect(spanWithId(html, ids[0] ?? '').text).toBe('Modelo da sessão');
    const provider = spanWithId(html, ids[1] ?? '');
    expect(provider.text).toBe('OpenRouter · Anthropic');
    expect(provider.openTag).not.toContain('aria-hidden');
    expect(html).toContain('<span aria-hidden="true" class="block truncate text-base text-foreground">Claude Opus latest</span>');
  });

  it('outros selects continuam sem optgroup mesmo com valores de provedor', () => {
    const mode: SelectOption = {
      id: 'mode',
      name: 'Acesso',
      description: null,
      category: 'mode',
      type: 'select',
      currentValue: 'cursor/x',
      options: [
        { value: 'cursor/x', name: 'Cursor X' },
        { value: 'claude-cli/y', name: 'Claude Y' },
      ],
    };
    const html = renderControls(mode);

    expect(html).not.toContain('optgroup');
    expect(html).not.toContain('aria-describedby');
  });
});
