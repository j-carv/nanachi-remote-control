import { describe, expect, it } from 'vitest';
import { DEFAULT_LANGUAGE, isLanguage, LANGUAGES, languageFromLocale } from '../src/common/i18n/index.js';

describe('language from the system locale (first run)', () => {
  it.each([
    ['es', 'es'],
    ['es-419', 'es'],
    ['es-MX', 'es'],
    ['es_AR', 'es'],
    ['ES', 'es'],
    ['pt', 'pt-BR'],
    ['pt-BR', 'pt-BR'],
    ['pt-PT', 'pt-BR'],
    ['pt_br', 'pt-BR'],
    ['en', 'en'],
    ['en-US', 'en'],
    ['en-GB', 'en'],
  ] as const)('%s -> %s', (locale, expected) => {
    expect(languageFromLocale(locale)).toBe(expected);
  });

  it.each(['de', 'fr-CA', 'ja', 'zh-CN', 'eo', 'esperanto', 'ptolemy', '', '   ', '-'])('anything else (%j) is English', (locale) => {
    expect(languageFromLocale(locale)).toBe('en');
  });

  it('nothing at all is English', () => {
    expect(languageFromLocale(undefined)).toBe('en');
    expect(languageFromLocale(null)).toBe('en');
  });
});

describe('languages', () => {
  it('offers pt-BR, English and Spanish, each labelled in its own language, and pt-BR is the default', () => {
    expect(LANGUAGES.map((language) => language.code)).toEqual(['pt-BR', 'en', 'es']);
    expect(LANGUAGES.map((language) => language.label)).toEqual(['Português (Brasil)', 'English', 'Español']);
    expect(DEFAULT_LANGUAGE).toBe('pt-BR');
  });

  it('isLanguage accepts only the three codes', () => {
    for (const code of ['pt-BR', 'en', 'es']) expect(isLanguage(code)).toBe(true);
    for (const value of ['pt', 'en-US', 'fr', '', null, undefined, 3, {}]) expect(isLanguage(value)).toBe(false);
  });
});
