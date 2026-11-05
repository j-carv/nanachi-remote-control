import { isLanguage, type Language } from '../i18n/languages.js';

/** The part of Desktop's bridge this module uses. Older Desktop builds do not have it. */
export interface DesktopLanguageSource {
  onLanguage?: ((callback: (language: unknown) => void) => () => void) | undefined;
}

/**
 * Follows the language of Nanachi Desktop, which embeds this app: when the user changes it in the control center, the app
 * switches at once through the bridge, without reloading the page (the connection and the open screen stay). Only a supported
 * language is applied. Returns the function that stops following, or null when there is nothing to follow (a browser, the
 * phone, or a Desktop from before this event: it then hands the language over when the page loads).
 */
export function followDesktopLanguage(
  bridge: DesktopLanguageSource | null,
  apply: (language: Language) => void,
): (() => void) | null {
  if (bridge === null || typeof bridge.onLanguage !== 'function') return null;
  return bridge.onLanguage((language) => {
    if (isLanguage(language)) apply(language);
  });
}
