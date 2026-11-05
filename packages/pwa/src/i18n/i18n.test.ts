import { createInstance } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentLanguage,
  DEFAULT_LANGUAGE,
  i18n,
  LANGUAGE_KEY,
  NAMESPACES,
  readStoredLanguage,
  setLanguage,
  SUPPORTED_LANGUAGES,
  t,
} from './index.js';
import { compareLocales, flattenLeaves, type LocaleFiles } from './localeCheck.js';
import { resources } from './resources.js';
import type { StorageLike } from '../machines.js';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

// Every translation file on disk, read the way the bundler does. The registry in resources.ts must match it.
const filesOnDisk = import.meta.glob<unknown>('./locales/*/*.json', { eager: true, import: 'default' });

function groupByLanguage(entries: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const grouped: Record<string, Record<string, unknown>> = {};
  for (const [path, content] of Object.entries(entries)) {
    const match = /^\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (match === null) throw new Error(`unexpected translation file path: ${path}`);
    const [, language = '', namespace = ''] = match;
    (grouped[language] ??= {})[namespace] = content;
  }
  return grouped;
}

describe('translation files', () => {
  const onDisk = groupByLanguage(filesOnDisk);
  const languages = SUPPORTED_LANGUAGES.map((language) => language.code);

  it('exist for exactly the supported languages', () => {
    expect(Object.keys(onDisk).sort()).toEqual([...languages].sort());
  });

  it('have the same namespaces, keys and placeholders in every language (pt-BR is the reference)', () => {
    const files: LocaleFiles = onDisk;
    expect(compareLocales(files, DEFAULT_LANGUAGE, NAMESPACES)).toEqual([]);
  });

  it('are all registered in resources.ts, each under its own language and namespace', () => {
    for (const language of languages) {
      for (const namespace of NAMESPACES) {
        expect(resources[language][namespace], `${language}/${namespace}`).toBe(onDisk[language]?.[namespace]);
      }
    }
  });
});

describe('readStoredLanguage', () => {
  it('is pt-BR when nothing is stored', () => {
    expect(readStoredLanguage(memoryStorage())).toBe('pt-BR');
  });

  it('returns the stored language when it is supported', () => {
    expect(readStoredLanguage(memoryStorage({ [LANGUAGE_KEY]: 'en' }))).toBe('en');
    expect(readStoredLanguage(memoryStorage({ [LANGUAGE_KEY]: 'es' }))).toBe('es');
    expect(readStoredLanguage(memoryStorage({ [LANGUAGE_KEY]: 'pt-BR' }))).toBe('pt-BR');
  });

  it('ignores a value that is not a supported language', () => {
    expect(readStoredLanguage(memoryStorage({ [LANGUAGE_KEY]: 'fr' }))).toBe('pt-BR');
    expect(readStoredLanguage(memoryStorage({ [LANGUAGE_KEY]: 'es-MX' }))).toBe('pt-BR');
    expect(readStoredLanguage(memoryStorage({ [LANGUAGE_KEY]: '' }))).toBe('pt-BR');
  });

  it('is pt-BR when the storage throws', () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(readStoredLanguage(blocked)).toBe('pt-BR');
  });
});

describe('setLanguage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts in pt-BR, and switches at once, in both directions', () => {
    expect(currentLanguage()).toBe('pt-BR');
    expect(t('common:actions.back')).toBe('Voltar');

    setLanguage('en', memoryStorage());
    expect(currentLanguage()).toBe('en');
    expect(t('common:actions.back')).toBe('Back');

    setLanguage('pt-BR', memoryStorage());
    expect(currentLanguage()).toBe('pt-BR');
    expect(t('common:actions.back')).toBe('Voltar');
  });

  it('switches to Spanish at once, and from Spanish to English and back to Portuguese', () => {
    setLanguage('es', memoryStorage());
    expect(currentLanguage()).toBe('es');
    expect(t('common:actions.back')).toBe('Volver');
    expect(t('common:actions.pairAgain')).toBe('Vincular de nuevo');

    setLanguage('en', memoryStorage());
    expect(t('common:actions.back')).toBe('Back');

    setLanguage('pt-BR', memoryStorage());
    expect(t('common:actions.back')).toBe('Voltar');
  });

  it('stores the choice under nanachi.language', () => {
    const storage = memoryStorage();
    setLanguage('en', storage);
    expect(storage.data.get('nanachi.language')).toBe('en');
    setLanguage('es', storage);
    expect(storage.data.get('nanachi.language')).toBe('es');
  });

  it('still switches when the storage refuses the write', () => {
    const full: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    setLanguage('en', full);
    expect(currentLanguage()).toBe('en');
  });

  it('sets <html lang>', () => {
    const documentElement = { lang: '' };
    vi.stubGlobal('document', { documentElement });
    setLanguage('en', memoryStorage());
    expect(documentElement.lang).toBe('en');
    setLanguage('es', memoryStorage());
    expect(documentElement.lang).toBe('es');
    setLanguage('pt-BR', memoryStorage());
    expect(documentElement.lang).toBe('pt-BR');
  });

  it('keeps the exported t valid after the language changes (it is bound to the instance)', () => {
    const { t: detached } = i18n;
    setLanguage('en', memoryStorage());
    expect(detached('common:actions.cancel')).toBe('Cancel');
    expect(t('common:actions.cancel')).toBe('Cancel');
  });

  it('falls back to pt-BR for a key that English lacks', () => {
    // Same options as the app's instance, with a bundle where English lacks a key.
    const partial = createInstance();
    void partial.init({
      ...i18n.options,
      resources: { 'pt-BR': { common: { onlyInPortuguese: 'só em português' } }, en: { common: {} } },
      lng: 'en',
      initAsync: false,
    });
    // The key is not in the real files, so the typed keys do not know it.
    expect(partial.t('onlyInPortuguese' as 'actions.back')).toBe('só em português');
  });

  it('uses _one and _other plural forms in each language', () => {
    expect(t('common:showAll', { count: 1 })).toBe('Mostrar tudo (1 linha)');
    expect(t('common:showAll', { count: 5 })).toBe('Mostrar tudo (5 linhas)');
    setLanguage('en', memoryStorage());
    expect(t('common:showAll', { count: 1 })).toBe('Show all (1 line)');
    expect(t('common:showAll', { count: 5 })).toBe('Show all (5 lines)');
  });

  it('uses _one, _many and _other in Spanish, with the words that agree with the count', () => {
    setLanguage('es', memoryStorage());
    expect(t('common:showAll', { count: 1 })).toBe('Mostrar todo (1 línea)');
    expect(t('common:showAll', { count: 5 })).toBe('Mostrar todo (5 líneas)');
    expect(t('common:showAll', { count: 1_000_000 })).toBe('Mostrar todo (1000000 de líneas)');
    expect(t('usage:resets.saved', { count: 0 })).toBe('0 guardados');
    expect(t('usage:resets.saved', { count: 1 })).toBe('1 guardado');
  });

  it('gives every Spanish plural text a form for every count, so no count shows a bare key', () => {
    // The rule is the engine's own, the one i18next asks: `many` is one million and its multiples in Spanish.
    const rules = new Intl.PluralRules('es');
    const counts = [0, 1, 2, 5, 21, 100, 999_999, 1_000_000, 2_000_000, 1_000_000_000];
    const missing: string[] = [];
    let plurals = 0;
    for (const [namespace, content] of Object.entries(resources.es)) {
      for (const key of flattenLeaves(content).keys()) {
        if (!key.endsWith('_other')) continue;
        const base = key.slice(0, -'_other'.length);
        plurals += 1;
        for (const count of counts) {
          const form = `${base}_${rules.select(count)}`;
          if (typeof i18n.getResource('es', namespace, form) !== 'string') missing.push(`${namespace}:${form} (count ${count})`);
        }
      }
    }
    expect(plurals).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
