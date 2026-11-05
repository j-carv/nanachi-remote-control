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

interface DeleteEntrySheetProps {
  name: string;
  isDir: boolean;
  busy: boolean;
  error: unknown;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * Confirmação de "Excluir" no explorador. Pasta só é apagada vazia: se o daemon recusar (`dir_not_empty`), a
 * mensagem aparece aqui, sem fechar a folha. Não fecha durante a exclusão.
 */
export function DeleteEntrySheet({ name, isDir, busy, error, onCancel, onConfirm }: DeleteEntrySheetProps) {
  const { t } = useTranslation('workspace');
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
          <DrawerTitle>{t('deleteEntry.title', { name })}</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">
            {isDir ? t('deleteEntry.dir') : t('deleteEntry.file')}
          </DrawerDescription>
        </DrawerHeader>
        <div className="px-5 pt-3">
          <ErrorNotice error={error} />
        </div>
        <DrawerFooter className="flex-row">
          <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
          <Button variant="destructive" className="flex-1" onClick={onConfirm} disabled={busy}>
            {busy ? t('deleteEntry.deleting') : t('deleteEntry.confirm')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
