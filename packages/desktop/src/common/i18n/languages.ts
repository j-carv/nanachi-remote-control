/**
 * The languages of Nanachi Desktop and how the first one is picked. No Electron and no i18next here: the main process,
 * the tray, the installer pages and the control center renderer all read it.
 */

/** The labels are always written in their own language, so a wrong switch can still be found and undone. */
export const LANGUAGES = [
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

/** The maintainer's language: what every test and every fallback starts from. */
export const DEFAULT_LANGUAGE: Language = 'pt-BR';

/** `localStorage` key of the embedded PWA's language (`packages/pwa/src/i18n/languages.ts`). Desktop writes only this key. */
export const PWA_LANGUAGE_KEY = 'nanachi.language';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((language) => language.code === value);
}

/**
 * The language for an operating system locale (`app.getLocale()`: `pt-BR`, `en-US`, `es-419`, ...), used on the first run:
 * `es*` is Spanish, `pt*` is Brazilian Portuguese, `en*` is English, and anything else (or nothing) is English. Only the
 * primary subtag counts, so `esperanto`-like codes (`eo`) and unknown scripts fall to English.
 */
export function languageFromLocale(locale: string | null | undefined): Language {
  if (typeof locale !== 'string') return 'en';
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === 'es') return 'es';
  if (primary === 'pt') return 'pt-BR';
  return 'en';
}
