import { pluralize } from '../lib/format.js';
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
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      dismissible={!busy}
      title="Reiniciar o Nanachi agora?"
      width={560}
      description={
        <>
          {busySessions > 0
            ? `Há ${pluralize(busySessions, 'sessão em andamento', 'sessões em andamento')}, que ${busySessions === 1 ? 'será interrompida' : 'serão interrompidas'}. `
            : ''}
          O reinício para o daemon e o inicia de novo: todas as sessões, em andamento ou não, ficam paradas e voltam quando você enviar uma mensagem nelas.
          {mode === 'save' ? ' Se preferir, salve agora e a nova lista passa a valer no próximo reinício.' : ''}
        </>
      }
      footer={
        <>
          <Button disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
          {mode === 'save' ? (
            <Button disabled={busy} onClick={onLater}>
              Salvar e aplicar depois
            </Button>
          ) : null}
          <Button variant="primary" loading={busy} onClick={onNow}>
            {mode === 'save' ? 'Salvar e reiniciar agora' : 'Reiniciar agora'}
          </Button>
        </>
      }
    />
  );
}
