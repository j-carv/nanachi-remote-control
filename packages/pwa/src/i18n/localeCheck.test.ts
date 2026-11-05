import { describe, expect, it } from 'vitest';
import { compareLocales, flattenLeaves, placeholdersOf, pluralCategoriesOf } from './localeCheck.js';

describe('flattenLeaves', () => {
  it('flattens nested objects into dotted paths and flags leaves that are not strings', () => {
    const leaves = flattenLeaves({ a: 'x', b: { c: 'y', d: { e: 'z' } }, n: 3, list: ['a'] });
    expect([...leaves]).toEqual([
      ['a', 'x'],
      ['b.c', 'y'],
      ['b.d.e', 'z'],
      ['n', null],
      ['list', null],
    ]);
  });
});

describe('placeholdersOf', () => {
  it('lists each placeholder once, sorted, ignoring spaces and format options', () => {
    expect(placeholdersOf('{{b}} and {{ a }} and {{b}} and {{c, number}}')).toEqual(['a', 'b', 'c']);
    expect(placeholdersOf('no placeholders')).toEqual([]);
  });
});

describe('compareLocales', () => {
  const base = {
    'pt-BR': { common: { hello: 'Olá, {{name}}', count_one: '{{count}} item', count_other: '{{count}} itens' } },
    en: { common: { hello: 'Hello, {{name}}', count_one: '{{count}} item', count_other: '{{count}} items' } },
  };

  it('accepts languages that agree', () => {
    expect(compareLocales(base, 'pt-BR', ['common'])).toEqual([]);
  });

  it('reports a namespace file that one language lacks', () => {
    const files = { 'pt-BR': base['pt-BR'], en: {} };
    expect(compareLocales(files, 'pt-BR', ['common'])).toContain('en/common.json is missing');
  });

  it('reports a file that is not a registered namespace', () => {
    const files = { ...base, en: { ...base.en, extra: {} } };
    expect(compareLocales(files, 'pt-BR', ['common'])).toContain('en/extra.json is not a registered namespace');
  });

  it('reports a key that one language lacks, and one it adds', () => {
    const files = {
      'pt-BR': base['pt-BR'],
      en: { common: { hello: 'Hello, {{name}}', count_one: '{{count}} item', count_other: '{{count}} items', more: 'x' } },
    };
    expect(compareLocales(files, 'pt-BR', ['common'])).toEqual(['en/common.json: extra key "more"']);

    const missing = { 'pt-BR': base['pt-BR'], en: { common: { hello: 'Hello, {{name}}' } } };
    expect(compareLocales(missing, 'pt-BR', ['common'])).toEqual([
      'en/common.json: missing key "count_one"',
      'en/common.json: missing key "count_other"',
    ]);
  });

  it('reports a placeholder that one language drops or renames', () => {
    const files = { 'pt-BR': base['pt-BR'], en: { common: { ...base.en.common, hello: 'Hello, {{who}}' } } };
    expect(compareLocales(files, 'pt-BR', ['common'])).toEqual([
      'en/common.json: "hello" uses {{who}} but pt-BR uses {{name}}',
    ]);
  });

  it('reports empty texts, values that are not strings and a plural without its _other form', () => {
    const files = {
      'pt-BR': { common: { empty: 'x', number: 'x', thing_one: 'x', thing_other: 'x' } },
      en: { common: { empty: ' ', number: 1, thing_one: 'x', thing_other: 'x' } },
    };
    expect(compareLocales(files, 'pt-BR', ['common'])).toEqual([
      'en/common.json: "empty" is empty',
      'en/common.json: "number" is not a string',
    ]);

    const lonely = { 'pt-BR': { common: { thing_one: 'x' } }, en: { common: { thing_one: 'x' } } };
    expect(compareLocales(lonely, 'pt-BR', ['common'])).toEqual([
      'pt-BR/common.json: "thing_one" has no "_other" form',
      'en/common.json: "thing_one" has no "_other" form',
    ]);
  });
});

describe('pluralCategoriesOf', () => {
  it('reports what the engine knows: Spanish and Portuguese have `many`, English does not', () => {
    expect(pluralCategoriesOf('en')).toEqual(expect.arrayContaining(['one', 'other']));
    expect(pluralCategoriesOf('en')).not.toContain('many');
    expect(pluralCategoriesOf('es')).toEqual(expect.arrayContaining(['one', 'many', 'other']));
    expect(pluralCategoriesOf('pt-BR')).toContain('many');
  });

  it('falls back to one and other for a code the engine rejects', () => {
    expect(pluralCategoriesOf('not a language')).toEqual(['one', 'other']);
  });
});

describe('compareLocales and the plural forms of each language', () => {
  const categories = (language: string): readonly string[] => (language === 'es' ? ['one', 'many', 'other'] : ['one', 'other']);
  const ptBr = { common: { hello: 'Olá', count_one: '{{count}} item', count_other: '{{count}} itens' } };
  const es = { hello: 'Hola', count_one: '{{count}} elemento', count_many: '{{count}} de elementos', count_other: '{{count}} elementos' };

  it('accepts the extra form a language needs next to the reference forms', () => {
    expect(compareLocales({ 'pt-BR': ptBr, es: { common: es } }, 'pt-BR', ['common'], categories)).toEqual([]);
  });

  it('reports a form the language needs for some counts but lacks (a count that picks it would show the bare key)', () => {
    const { count_many: _many, ...withoutMany } = es;
    expect(compareLocales({ 'pt-BR': ptBr, es: { common: withoutMany } }, 'pt-BR', ['common'], categories)).toEqual([
      'es/common.json: "count" has no "_many" form, which es uses for some counts',
    ]);
  });

  it('does not ask for a form the language never uses, and does not check the reference language itself', () => {
    const files = { 'pt-BR': ptBr, en: { common: { hello: 'Hello', count_one: '{{count}} item', count_other: '{{count}} items' } } };
    expect(compareLocales(files, 'pt-BR', ['common'], () => ['one', 'many', 'other'])).toEqual([
      'en/common.json: "count" has no "_many" form, which en uses for some counts',
    ]);
    expect(compareLocales(files, 'pt-BR', ['common'], categories)).toEqual([]);
  });

  it('measures an extra form against the reference _other text: its placeholders must match', () => {
    const wrong = { ...es, count_many: '{{total}} de elementos' };
    expect(compareLocales({ 'pt-BR': ptBr, es: { common: wrong } }, 'pt-BR', ['common'], categories)).toEqual([
      'es/common.json: "count_many" uses {{total}} but pt-BR uses {{count}}',
    ]);
  });

  it('still reports an extra key that is not a plural form of a reference text', () => {
    const files = { 'pt-BR': ptBr, es: { common: { ...es, other_many: 'x', more: 'y' } } };
    expect(compareLocales(files, 'pt-BR', ['common'], categories)).toEqual([
      'es/common.json: extra key "other_many"',
      'es/common.json: extra key "more"',
    ]);
  });
});
