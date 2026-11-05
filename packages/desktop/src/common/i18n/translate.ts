import { DEFAULT_LANGUAGE, type Language } from './languages.js';
import { dictionaries, type Dictionary } from './locales/index.js';

/**
 * A small translator for everything that is not the control center renderer (which uses i18next on the same
 * dictionaries): the main process, the tray, the status pages and the installer pages. No runtime dependency.
 *
 * Keys are dotted paths from a group of the dictionary (`main.tray.openSessions`). A plural uses the i18next convention:
 * `key_one` and `key_other` (and the other CLDR categories when a language needs them) are looked up from `params.count`,
 * and the caller writes the base `key`. `{{name}}` is replaced by `params.name`.
 */

const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
type PluralSuffix = (typeof PLURAL_CATEGORIES)[number];

/** `foo_one` and `foo_other` are one message, `foo`. */
type BaseKey<K extends string> = K extends `${infer Base}_${PluralSuffix}` ? Base : K;

type LeafKeys<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? BaseKey<`${Prefix}${K}`> : LeafKeys<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every message of the dictionary, as the dotted path the caller writes. */
export type MessageKey = LeafKeys<Dictionary>;

export type Params = Readonly<Record<string, string | number>>;

function lookup(dictionary: unknown, key: string): string | undefined {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const pluralRules = new Map<Language, Intl.PluralRules>();
function pluralCategory(language: Language, count: number): PluralSuffix {
  let rules = pluralRules.get(language);
  if (rules === undefined) {
    rules = new Intl.PluralRules(language);
    pluralRules.set(language, rules);
  }
  return rules.select(count);
}

function interpolate(template: string, params: Params | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * The text of `key` in `language`. A key that a language lacks falls back to pt-BR (the tests make sure it never happens),
 * and a key that exists nowhere is returned as it is, so a bug shows up as a visible key and never as an exception.
 */
export function translate(language: Language, key: MessageKey, params?: Params): string {
  const count = params?.count;
  const candidates: string[] = [];
  if (typeof count === 'number') candidates.push(`${key}_${pluralCategory(language, count)}`, `${key}_other`);
  candidates.push(key);
  for (const source of language === DEFAULT_LANGUAGE ? [language] : [language, DEFAULT_LANGUAGE]) {
    for (const candidate of candidates) {
      const text = lookup(dictionaries[source], candidate);
      if (text !== undefined) return interpolate(text, params);
    }
  }
  return key;
}

let current: Language = DEFAULT_LANGUAGE;

/** The language this process speaks: the main process sets it from Desktop's setting, an installer page from the process locale. */
export function setLanguage(language: Language): void {
  current = language;
}

export function getLanguage(): Language {
  return current;
}

/** `translate` in the current language. */
export function t(key: MessageKey, params?: Params): string {
  return translate(current, key, params);
}
