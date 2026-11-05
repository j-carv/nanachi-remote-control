/** Languages the app is translated into. The labels are always written in their own language. */
export const SUPPORTED_LANGUAGES = [
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'en', label: 'English' },
] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/** The maintainer's language, used when nothing is stored (it also keeps every E2E selector valid). */
export const DEFAULT_LANGUAGE: Language = 'pt-BR';

/** localStorage key of the language chosen on this device. */
export const LANGUAGE_KEY = 'nanachi.language';

/** Title of the Settings section. The same text in every language, so it can be found after a wrong switch. */
export const LANGUAGE_SECTION_TITLE = 'Idioma / Language';

export function isLanguage(value: unknown): value is Language {
  return SUPPORTED_LANGUAGES.some((language) => language.code === value);
}
