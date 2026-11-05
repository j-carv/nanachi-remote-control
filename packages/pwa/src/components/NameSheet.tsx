import { useState, type FormEvent } from 'react';
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
  onCancel,
  onSubmit,
}: NameSheetProps) {
  const [name, setName] = useState(initialName);
  const problem = validateEntryName(name);
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
      <DrawerContent>
        <form onSubmit={submit}>
          <DrawerHeader>
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription className="text-base leading-6 text-foreground/80">{description}</DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-2 px-5 pt-4">
            <Label htmlFor="entry-name" className="text-sm text-muted-foreground">
              Nome
            </Label>
            <Input
              id="entry-name"
              autoFocus
              value={name}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="done"
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
              <ErrorNotice error={error} />
            </div>
          </div>
          <DrawerFooter className="flex-row">
            <Button type="button" variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
              Cancelar
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={busy || problem !== null || unchanged}
            >
              {busy ? 'Aguarde…' : submitLabel}
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}
