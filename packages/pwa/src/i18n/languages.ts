import { APP_LANGUAGES, type AppLanguage } from '@nanachi/shared';

/** The labels are always written in their own language. */
const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  'pt-BR': 'Português (Brasil)',
  en: 'English',
  es: 'Español',
};

/**
 * Languages the app is translated into. The codes come from the shared protocol (`APP_LANGUAGES`), which the daemon
 * also uses to write the push texts, so the two lists cannot drift apart.
 */
export const SUPPORTED_LANGUAGES = APP_LANGUAGES.map((code) => ({ code, label: LANGUAGE_LABELS[code] }));

export type Language = AppLanguage;

/** The maintainer's language, used when nothing is stored (it also keeps every E2E selector valid). */
export const DEFAULT_LANGUAGE: Language = 'pt-BR';

/** localStorage key of the language chosen on this device. */
export const LANGUAGE_KEY = 'nanachi.language';

/**
 * Title of the Settings section. The same text in every language, so it can be found after a wrong switch. "Idioma" is
 * the Spanish word as well as the Portuguese one, so it reads naturally in all three languages.
 */
export const LANGUAGE_SECTION_TITLE = 'Idioma / Language';

export function isLanguage(value: unknown): value is Language {
  return SUPPORTED_LANGUAGES.some((language) => language.code === value);
}
