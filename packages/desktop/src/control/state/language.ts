import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LANGUAGE, isLanguage, type Language } from '../../common/i18n/index.js';
import { useApi } from './api.js';

/** The control center's language now, and the way to change it. Main stays the source of truth: the choice goes there first. */
export function useLanguageSetting(): { language: Language; busy: boolean; change: (language: Language) => Promise<boolean> } {
  const api = useApi();
  const { i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const language = isLanguage(i18n.language) ? i18n.language : DEFAULT_LANGUAGE;

  const change = useCallback(
    async (next: Language): Promise<boolean> => {
      if (next === language) return true;
      setBusy(true);
      try {
        // Main switches the tray, its own messages and the PWA, and tells every window; the page also follows the answer, so
        // it does not wait for the event to be delivered.
        const effective = await api.settings.setLanguage(next);
        if (isLanguage(effective)) await i18n.changeLanguage(effective);
        return true;
      } catch {
        return false;
      } finally {
        setBusy(false);
      }
    },
    [api, i18n, language],
  );

  return { language, busy, change };
}
