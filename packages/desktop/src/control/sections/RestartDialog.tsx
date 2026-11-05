import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';

export interface RestartDialogProps {
  open: boolean;
  /** `save` also offers to save now and restart later; `restart` only restarts. */
  mode: 'save' | 'restart';
  /** Sessions that are running or waiting for permission (the ones that lose work). */
  busySessions: number;
  busy: boolean;
  onCancel: () => void;
  onLater: () => void;
  onNow: () => void;
}

/**
 * A restart from Desktop stops the daemon and starts it again, so every session comes back stopped (the busy ones lose
 * what they were doing); each one resumes when the user sends it a message. The dialog says exactly that.
 */
export function RestartDialog({ open, mode, busySessions, busy, onCancel, onLater, onNow }: RestartDialogProps) {
  const { t } = useTranslation();
  const sentences: Array<string | null> = [
    busySessions > 0 ? t('restart.busySessions', { count: busySessions }) : null,
    t('restart.explanation'),
    mode === 'save' ? t('restart.saveHint') : null,
  ];
  const description = sentences.filter((sentence): sentence is string => sentence !== null).join(' ');
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      dismissible={!busy}
      title={t('restart.title')}
      width={560}
      description={description}
      footer={
        <>
          <Button disabled={busy} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {mode === 'save' ? (
            <Button disabled={busy} onClick={onLater}>
              {t('restart.saveLater')}
            </Button>
          ) : null}
          <Button variant="primary" loading={busy} onClick={onNow}>
            {mode === 'save' ? t('restart.saveNow') : t('common.restartNow')}
          </Button>
        </>
      }
    />
  );
}
