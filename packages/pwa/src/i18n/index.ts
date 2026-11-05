import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getBrowserStorage } from '../browserStorage.js';
import type { StorageLike } from '../machines.js';
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  LANGUAGE_KEY,
  SUPPORTED_LANGUAGES,
  type Language,
} from './languages.js';
import { DEFAULT_NAMESPACE, NAMESPACES, resources } from './resources.js';

export { DEFAULT_LANGUAGE, LANGUAGE_KEY, LANGUAGE_SECTION_TITLE, SUPPORTED_LANGUAGES, isLanguage, type Language } from './languages.js';
export { NAMESPACES, type Namespace } from './resources.js';

/** The language stored on this device, or the default one when nothing valid is stored (or storage throws). */
export function readStoredLanguage(storage: StorageLike): Language {
  try {
    const stored = storage.getItem(LANGUAGE_KEY);
    return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

function writeStoredLanguage(storage: StorageLike, language: Language): void {
  try {
    storage.setItem(LANGUAGE_KEY, language);
  } catch {
    // The choice is a convenience: without storage it lasts until the page closes.
  }
}

function applyDocumentLanguage(language: Language): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

/**
 * The app's i18next instance. Every language and namespace is bundled, so `init` finishes synchronously
 * (`initAsync: false`) and the first render already has its texts.
 */
export const i18n = createInstance();

const initialLanguage = readStoredLanguage(getBrowserStorage());

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: SUPPORTED_LANGUAGES.map((language) => language.code),
  load: 'currentOnly',
  ns: [...NAMESPACES],
  defaultNS: DEFAULT_NAMESPACE,
  initAsync: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

applyDocumentLanguage(initialLanguage);

/**
 * Translation function for code that runs outside React (helpers, reducers, error texts). Prefix the namespace:
 * `t('errors:api.network')`. Inside components use `useTranslation(namespace)`. The instance binds its own methods, so
 * this stays valid after the language changes.
 */
export const t = i18n.t;

/** The language in use. */
export function currentLanguage(): Language {
  return isLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE;
}

/**
 * Switches the language: stores the choice on this device, changes i18next (components that use `useTranslation`
 * re-render) and sets `<html lang>`. The screens are keyed on the language in `App`, so helpers that call `t` while
 * rendering pick the change up too.
 */
export function setLanguage(language: Language, storage: StorageLike = getBrowserStorage()): void {
  writeStoredLanguage(storage, language);
  void i18n.changeLanguage(language);
  applyDocumentLanguage(language);
}
