import type { Language } from '../common/i18n/index.js';
import { languageForSettingsFile } from './settings.js';

/**
 * The language of the uninstall window: the one Desktop is set to, which is the one it stored (Portuguese for an upgrade that
 * never chose), and the system locale when there is no setting file (a Desktop that never ran). Never throws.
 */
export function readUninstallLanguage(settingsFile: string, locale: string | null | undefined): Language {
  return languageForSettingsFile(settingsFile, locale);
}
