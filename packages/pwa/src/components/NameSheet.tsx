import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { validateEntryName } from '../workspace/paths.js';
import { ErrorNotice } from './ErrorNotice.js';

interface NameSheetProps {
  title: string;
  description: string;
  submitLabel: string;
  /** Nome que já vem no campo (o nome atual, ao renomear). */
  initialName: string;
  busy: boolean;
  error: unknown;
  /** Own text for the error (it wins over `error`), for failures the generic texts do not know (e.g. account codes). */
  errorText?: string | undefined;
  /** Rules for the name. Default: the file and folder name rules (`validateEntryName`). */
  validate?: ((name: string) => string | null) | undefined;
  /** Mixed case on the first letter (a label such as an account name). Default: off, as for file names. */
  capitalize?: boolean | undefined;
  onCancel(): void;
  onSubmit(name: string): void;
}

/**
 * Folha com um campo de nome: novo arquivo, nova pasta e renomear. O nome é validado antes do envio (regras do
 * daemon, `validateEntryName`); o daemon continua sendo quem decide.
 */
export function NameSheet({
  title,
  description,
  submitLabel,
  initialName,
  busy,
  error,
  errorText,
  validate = validateEntryName,
  capitalize = false,
  onCancel,
  onSubmit,
}: NameSheetProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const problem = validate(name);
  const trimmed = name.trim();
  const unchanged = trimmed === initialName;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem !== null || busy || unchanged) return;
    onSubmit(trimmed);
  }

  return (
    <Drawer
      open
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DrawerContent size="sm">
        <form onSubmit={submit}>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription className="text-base leading-6 text-foreground/80">{description}</DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-2 px-5 pt-4">
            <Label htmlFor="entry-name" className="text-sm text-muted-foreground">
              {t('fields.name')}
            </Label>
            <Input
              id="entry-name"
              autoFocus
              value={name}
              autoCapitalize={capitalize ? 'sentences' : 'none'}
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
              className="wide:h-9"
              onChange={(event) => setName(event.target.value)}
              aria-invalid={problem !== null && name !== ''}
              aria-describedby={problem !== null && name !== '' ? 'entry-name-problem' : undefined}
            />
            {problem !== null && name !== '' && (
              <p id="entry-name-problem" className="text-sm text-destructive">
                {problem}
              </p>
            )}
            <div className="pt-1">
              <ErrorNotice error={error} message={errorText} />
            </div>
          </div>
          <DrawerFooter className="flex-row wide:justify-end wide:pt-2 wide:pb-5">
            <Button type="button" variant="secondary" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onCancel} disabled={busy}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              size="compact"
              className="flex-1 wide:min-w-24 wide:flex-none"
              disabled={busy || problem !== null || unchanged}
            >
              {busy ? t('states.wait') : submitLabel}
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}
