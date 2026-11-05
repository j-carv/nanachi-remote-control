import { describe, expect, it } from 'vitest';
import { dictionaries, LANGUAGES, type Language } from '../src/common/i18n/index.js';

/** Every leaf of a dictionary as `path -> text`. */
function flatten(node: unknown, prefix = ''): Map<string, string> {
  const leaves = new Map<string, string>();
  if (typeof node === 'string') {
    leaves.set(prefix, node);
    return leaves;
  }
  if (typeof node !== 'object' || node === null) throw new Error(`${prefix}: not a string or an object`);
  for (const [key, value] of Object.entries(node)) {
    for (const [path, text] of flatten(value, prefix === '' ? key : `${prefix}.${key}`)) leaves.set(path, text);
  }
  return leaves;
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1] ?? '').sort();

const model = flatten(dictionaries['pt-BR']);
const others = LANGUAGES.map((language) => language.code).filter((code): code is Exclude<Language, 'pt-BR'> => code !== 'pt-BR');

describe('dictionaries', () => {
  it('the three groups exist in every language', () => {
    for (const { code } of LANGUAGES) expect(Object.keys(dictionaries[code]).sort(), code).toEqual(['control', 'installer', 'main']);
  });

  it.each(others)('%s has exactly the keys of pt-BR', (code) => {
    const keys = flatten(dictionaries[code]);
    expect([...keys.keys()].filter((key) => !model.has(key)), 'extra keys').toEqual([]);
    expect([...model.keys()].filter((key) => !keys.has(key)), 'missing keys').toEqual([]);
  });

  it.each(others)('%s keeps the placeholders of pt-BR, key by key', (code) => {
    const keys = flatten(dictionaries[code]);
    for (const [key, text] of model) expect(placeholders(keys.get(key) ?? ''), `${code} ${key}`).toEqual(placeholders(text));
  });

  it.each(LANGUAGES.map((language) => language.code))('%s has no empty text and no text with stray whitespace at its ends', (code) => {
    for (const [key, text] of flatten(dictionaries[code])) {
      expect(text.trim().length, `${code} ${key} is empty`).toBeGreaterThan(0);
      expect(text, `${code} ${key}`).toBe(text.trim());
    }
  });

  it('a plural always comes with both `_one` and `_other`, in every language', () => {
    for (const { code } of LANGUAGES) {
      const keys = [...flatten(dictionaries[code]).keys()];
      for (const key of keys) {
        const plural = /^(.*)_(one|other)$/.exec(key);
        if (plural === null) continue;
        const base = plural[1] ?? '';
        expect(keys, `${code} ${base}`).toContain(`${base}_one`);
        expect(keys, `${code} ${base}`).toContain(`${base}_other`);
      }
    }
  });
});
