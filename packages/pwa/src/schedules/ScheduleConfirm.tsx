import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { ErrorNotice } from '../components/ErrorNotice.js';

export function ScheduleConfirm({ title, description, label, busy, error, destructive = false, onConfirm, onCancel }: {
  title: string; description: string; label: string; busy: boolean; error: unknown; destructive?: boolean;
  onConfirm(): void; onCancel(): void;
}) {
  const { t } = useTranslation('schedules');
  return <Drawer open dismissible={!busy} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
    <DrawerContent size="sm">
      <DrawerHeader><DrawerTitle>{title}</DrawerTitle><DrawerDescription className="text-base leading-6">{description}</DrawerDescription></DrawerHeader>
      <div className="px-5 pt-3"><ErrorNotice error={error} /></div>
      <DrawerFooter className="flex-row">
        <Button type="button" variant="secondary" className="min-h-11 flex-1" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        <Button type="button" data-slot="schedule-confirm" variant={destructive ? 'destructive' : 'default'} className="min-h-11 flex-1 whitespace-normal" disabled={busy} aria-busy={busy} onClick={onConfirm}>{busy ? t('saving') : label}</Button>
      </DrawerFooter>
    </DrawerContent>
  </Drawer>;
}
