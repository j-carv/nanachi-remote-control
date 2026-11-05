import { CircleExclamationPoint } from 'lucide-react';
import { ApiError } from '../api.js';
import { describeWorkspaceError } from '../errorMessages.js';
import { Button } from '@/components/ui/button';

interface ErrorNoticeProps {
  error?: unknown;
  /** Texto próprio, para aviso que não vem de erro de API (ex.: o acesso não pôde ser salvo). Vence `error`. */
  message?: string | undefined;
  /** Quando dado, erro de autorização mostra o botão para parear de novo. */
  onRepair?: (() => void) | undefined;
  /** Ação extra ao lado da mensagem (ex.: abrir uma sessão nova quando o agente não retoma). */
  action?: { label: string; onClick: () => void } | undefined;
}

/** Erro inline: fundo vermelho tingido, ícone e texto. Sem borda colorida. */
export function ErrorNotice({ error, message, onRepair, action }: ErrorNoticeProps) {
  if (message === undefined && (error === undefined || error === null)) return null;
  const canRepair =
    message === undefined && error instanceof ApiError && error.kind === 'unauthorized' && onRepair !== undefined;

  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground">
      <div className="flex gap-3">
        <CircleExclamationPoint className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <p className="min-w-0 leading-5">{message ?? describeWorkspaceError(error)}</p>
      </div>
      {(canRepair || action !== undefined) && (
        <div className="flex flex-wrap gap-2">
          {canRepair && (
            <Button size="default" onClick={onRepair}>
              Parear de novo
            </Button>
          )}
          {action !== undefined && (
            <Button variant="secondary" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
