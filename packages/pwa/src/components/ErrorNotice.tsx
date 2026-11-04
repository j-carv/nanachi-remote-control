import { ApiError } from '../api.js';
import { describeError } from '../errorMessages.js';

interface ErrorNoticeProps {
  error: unknown;
  /** Quando dado, erro de autorização mostra o botão para parear de novo. */
  onRepair?: (() => void) | undefined;
  /** Ação extra ao lado da mensagem (ex.: abrir uma sessão nova quando o agente não retoma). */
  action?: { label: string; onClick: () => void } | undefined;
}

export function ErrorNotice({ error, onRepair, action }: ErrorNoticeProps) {
  if (error === null) return null;
  const canRepair = error instanceof ApiError && error.kind === 'unauthorized' && onRepair !== undefined;

  return (
    <div className="error" role="alert">
      <p>{describeError(error)}</p>
      {canRepair && (
        <button type="button" className="button primary" onClick={onRepair}>
          Parear de novo
        </button>
      )}
      {action !== undefined && (
        <button type="button" className="button primary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
