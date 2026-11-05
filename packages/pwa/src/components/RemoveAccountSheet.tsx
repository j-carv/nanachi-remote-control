import { removeAccountText } from '../agentAccounts.js';
import { describeAccountError } from '../errorMessages.js';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { ErrorNotice } from './ErrorNotice.js';

interface RemoveAccountSheetProps {
  agentLabel: string;
  accountLabel: string;
  busy: boolean;
  error: unknown;
  onCancel(): void;
  onConfirm(): void;
}

/** Confirmation to remove an extra account: bottom sheet. It does not close while the removal runs. */
export function RemoveAccountSheet({ agentLabel, accountLabel, busy, error, onCancel, onConfirm }: RemoveAccountSheetProps) {
  return (
    <Drawer
      open
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Remover conta</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">
            {removeAccountText(agentLabel, accountLabel)}
          </DrawerDescription>
        </DrawerHeader>
        {error !== null && error !== undefined && (
          <div className="flex flex-col gap-3 px-5 pt-3">
            <ErrorNotice message={describeAccountError(error)} />
          </div>
        )}
        <DrawerFooter className="flex-row">
          <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="destructive" className="flex-1" onClick={onConfirm} disabled={busy}>
            {busy ? 'Removendo…' : 'Remover'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
