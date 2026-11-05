import { createInstance, type i18n as I18nInstance, type TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { dictionaries, LANGUAGES, type Language } from '../common/i18n/index.js';

/**
 * i18next for the control center renderer, on the dictionaries of `src/common/i18n` (the main process and the installer read
 * the same files without i18next). Every language is bundled: no lazy loading, no backend, no language detector. One
 * instance per `App`, so a test can render the same view in any language.
 *
 * The page never decides its language: it starts from `window.nanachiControl.language` and follows `onLanguage`, so main
 * stays the single source of truth (the tray and main's own messages switch together with the page).
 */

/** The `t` of the control namespace, for helpers outside React (pure functions that build display text). */
export type ControlT = TFunction<'control'>;

const resources = Object.fromEntries(LANGUAGES.map(({ code }) => [code, { control: dictionaries[code].control }]));

export function createControlI18n(language: Language): I18nInstance {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'pt-BR',
    supportedLngs: LANGUAGES.map(({ code }) => code),
    load: 'currentOnly',
    ns: ['control'],
    defaultNS: 'control',
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}
