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
import { ErrorNotice } from './ErrorNotice.js';

interface RevokeDeviceSheetProps {
  name: string;
  busy: boolean;
  error: unknown;
  onCancel(): void;
  onConfirm(): void;
}

/** Confirmation to revoke another paired device: bottom sheet. It does not close while the revocation runs. */
export function RevokeDeviceSheet({ name, busy, error, onCancel, onConfirm }: RevokeDeviceSheetProps) {
  const { t } = useTranslation('devices');
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
          <DrawerTitle>{t('confirmTitle', { name })}</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">{t('confirmText')}</DrawerDescription>
        </DrawerHeader>
        <RevokeDeviceBody busy={busy} error={error} onCancel={onCancel} onConfirm={onConfirm} />
      </DrawerContent>
    </Drawer>
  );
}

interface RevokeDeviceBodyProps {
  busy: boolean;
  error: unknown;
  onCancel(): void;
  onConfirm(): void;
}

/** The error and the buttons of the confirmation. Kept apart from the sheet so the markup can be rendered without a Drawer. */
export function RevokeDeviceBody({ busy, error, onCancel, onConfirm }: RevokeDeviceBodyProps) {
  const { t } = useTranslation('devices');
  return (
    <>
      {error !== null && error !== undefined && (
        <div className="flex flex-col gap-3 px-5 pt-3">
          <ErrorNotice error={error} />
        </div>
      )}
      <DrawerFooter className="flex-row wide:justify-end wide:pt-2 wide:pb-5">
        <Button variant="secondary" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onCancel} disabled={busy}>
          {t('actions.cancel', { ns: 'common' })}
        </Button>
        <Button variant="destructive" size="compact" className="flex-1 wide:min-w-24 wide:flex-none" onClick={onConfirm} disabled={busy}>
          {busy ? t('revoking') : t('confirmAction')}
        </Button>
      </DrawerFooter>
    </>
  );
}
