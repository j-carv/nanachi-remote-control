import type { SessionStatus } from '@nanachi/shared';
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

/** Confirmação de "Remover do app". Não é `window.confirm`: a folha segue o visual do app. */
export function RemoveSessionSheet({ agentLabel, status, busy, error, onCancel, onConfirm }: RemoveSessionSheetProps) {
  const notice = removalInterruptNotice(status);

  return (
    <div className="sheet-backdrop" onClick={busy ? undefined : onCancel}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-session-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="remove-session-title">Remover do app</h2>
        <p className="remove-text">{removalConfirmText(agentLabel)}</p>
        {notice !== null && <p className="remove-notice">{notice}</p>}
        <ErrorNotice error={error} />
        <div className="sheet-actions">
          <button type="button" className="button secondary" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="button danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Removendo…' : 'Remover'}
          </button>
        </div>
      </section>
    </div>
  );
}
