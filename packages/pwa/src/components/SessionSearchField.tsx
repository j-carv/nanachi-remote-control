import { X } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SessionSearchFieldProps {
  value: string;
  onChange(value: string): void;
}

/**
 * The search box of a session list. It filters as the user types. The keyboard's Search key closes the keyboard so the
 * results show; Escape and the clear button empty the box. The attributes ask iOS for the search keyboard, with no
 * autocorrect and no capital letter at the start.
 */
export function SessionSearchField({ value, onChange }: SessionSearchFieldProps) {
  const { t } = useTranslation('common');
  const inputRef = useRef<HTMLInputElement>(null);

  function clear() {
    onChange('');
    inputRef.current?.focus();
  }

  return (
    <form
      role="search"
      className="relative"
      onSubmit={(event) => {
        event.preventDefault();
        inputRef.current?.blur();
      }}
    >
      <Input
        ref={inputRef}
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        placeholder={t('search.placeholder')}
        aria-label={t('search.label')}
        className="pr-11 [&::-webkit-search-cancel-button]:appearance-none"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value.length > 0) {
            event.preventDefault();
            clear();
          }
        }}
      />
      {value.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-0 right-0"
          aria-label={t('search.clear')}
          title={t('search.clear')}
          onClick={clear}
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </form>
  );
}
