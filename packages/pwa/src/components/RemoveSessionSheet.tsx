import type { SessionStatus } from '@nanachi/shared';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { removalConfirmText, removalInterruptNotice } from '../sessionRemoval.js';
import { ErrorNotice } from './ErrorNotice.js';

interface RemoveSessionSheetProps {
  agentLabel: string;
  status: SessionStatus;
  busy: boolean;
  error: unknown;
  onCancel(): void;
  onConfirm(): void;
}

/** Confirmação de "Remover do app": folha inferior. Não fecha durante a remoção. */
export function RemoveSessionSheet({ agentLabel, status, busy, error, onCancel, onConfirm }: RemoveSessionSheetProps) {
  const notice = removalInterruptNotice(status);

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
          <DrawerTitle>Remover do app</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">
            {removalConfirmText(agentLabel)}
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-3 px-5 pt-3">
          {notice !== null && <p className="text-sm leading-5 text-muted-foreground">{notice}</p>}
          <ErrorNotice error={error} />
        </div>
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
