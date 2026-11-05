import type { SessionStatus } from '@nanachi/shared';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('accounts');
  const notice = removalInterruptNotice(status);

  return (
    <Drawer
      open
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DrawerContent size="sm">
        <DrawerHeader>
          <DrawerTitle>{t('removeSession.title')}</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">
            {removalConfirmText(agentLabel)}
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-3 px-5 pt-3">
          {notice !== null && <p className="text-sm leading-5 text-muted-foreground">{notice}</p>}
          <ErrorNotice error={error} />
        </div>
        <DrawerFooter className="flex-row wide:justify-end wide:pt-2 wide:pb-5">
          <Button variant="secondary" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onCancel} disabled={busy}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button variant="destructive" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onConfirm} disabled={busy}>
            {busy ? t('removeSession.removing') : t('removeSession.confirm')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
