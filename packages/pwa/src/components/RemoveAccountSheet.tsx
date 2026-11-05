import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('accounts');
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
          <DrawerTitle>{t('remove.title')}</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">
            {removeAccountText(agentLabel, accountLabel)}
          </DrawerDescription>
        </DrawerHeader>
        {error !== null && error !== undefined && (
          <div className="flex flex-col gap-3 px-5 pt-3">
            <ErrorNotice message={describeAccountError(error)} />
          </div>
        )}
        <DrawerFooter className="flex-row wide:justify-end wide:pt-2 wide:pb-5">
          <Button variant="secondary" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onCancel} disabled={busy}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button variant="destructive" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onConfirm} disabled={busy}>
            {busy ? t('remove.removing') : t('remove.confirm')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
