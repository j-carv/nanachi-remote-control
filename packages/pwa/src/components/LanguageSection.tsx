import { ChevronsUpDown, Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  currentLanguage,
  isLanguage,
  LANGUAGE_SECTION_TITLE,
  setLanguage,
  SUPPORTED_LANGUAGES,
} from '../i18n/index.js';
import { ListGroup, listRowClass, SectionHeading } from './ListGroup.js';

/**
 * Settings row that picks the app language. The section title and the option names are the same in every language
 * ("Idioma / Language", "Português (Brasil)", "English", "Español"), so the row can be found after a switch to a
 * language the user does not read. The native select opens the iOS wheel, like the session pickers.
 */
export function LanguageSection() {
  // Subscribes to the language, so the select shows the new value (the screen is remounted on a change anyway).
  const { t } = useTranslation('settings');

  return (
    <section aria-labelledby="language-title" className="flex flex-col gap-2">
      <SectionHeading icon={Languages} id="language-title">
        {LANGUAGE_SECTION_TITLE}
      </SectionHeading>
      <ListGroup>
        <li>
          <label data-slot="language-row" className={`${listRowClass} justify-between`}>
            <span className="shrink-0 text-base">{t('language.label')}</span>
            <span className="relative flex min-w-0 max-w-[62%] items-center">
              <select
                data-slot="language-select"
                value={currentLanguage()}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isLanguage(next)) setLanguage(next);
                }}
                className="h-11 w-full min-w-0 appearance-none truncate bg-transparent py-0 pr-6 pl-2 text-right text-base text-foreground outline-none"
              >
                {SUPPORTED_LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code} lang={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
              <ChevronsUpDown
                className="pointer-events-none absolute right-0 size-4 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
          </label>
        </li>
      </ListGroup>
    </section>
  );
}
