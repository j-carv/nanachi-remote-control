import type { KeyboardEvent } from 'react';
import { LANGUAGES, type Language } from '../../common/i18n/index.js';
import { cx } from './cx.js';

export interface LanguageSelectProps {
  value: Language;
  onChange: (language: Language) => void;
  disabled?: boolean;
  /** The id of the element that names the group ("Idioma"). */
  labelledBy: string;
}

/**
 * The three languages as a segmented control. Each label is written in its own language (Português (Brasil), English,
 * Español), so a wrong switch can always be found and undone. A radio group: Left and Right move the choice, as in any
 * native one.
 */
export function LanguageSelect({ value, onChange, disabled = false, labelledBy }: LanguageSelectProps) {
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const index = LANGUAGES.findIndex((language) => language.code === value);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = LANGUAGES[(index + step + LANGUAGES.length) % LANGUAGES.length];
    if (next === undefined) return;
    onChange(next.code);
    // The focus follows the choice, which is the one tab stop of the group.
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
    buttons[LANGUAGES.indexOf(next)]?.focus();
  };

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} onKeyDown={move} data-slot="language-select" className="inline-flex rounded-lg bg-muted p-0.5">
      {LANGUAGES.map((language) => {
        const selected = language.code === value;
        return (
          <button
            key={language.code}
            type="button"
            role="radio"
            lang={language.code}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(language.code)}
            className={cx(
              'h-7 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 disabled:opacity-60',
              selected ? 'bg-card text-foreground shadow-[0_0_0_1px_var(--ui-border),0_1px_2px_rgb(0_0_0/0.06)]' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {language.label}
          </button>
        );
      })}
    </div>
  );
}
