import type { SessionEvent } from '@nanachi/shared';

/**
 * Momentos em que algo pede atenção do usuário. Hoje ninguém escuta: a fase de Web Push liga um handler
 * (ServerDeps.onNotify) que envia a notificação. Até lá o callback é opcional e não faz nada.
 */
export type NotifyKind = 'turn_end' | 'permission_request' | 'user_question' | 'file_request' | 'preview' | 'error' | 'file' | 'loop_paused';

/**
 * O próprio evento gravado, já estreitado para os tipos que avisam. `terminal_exit` (fim de sessão PTY) avisa
 * como `turn_end`: o notificador distingue pelo detalhe.
 */
export type NotifyDetails = Extract<SessionEvent, { kind: Exclude<NotifyKind, 'loop_paused'> | 'terminal_exit' }> | LoopPausedDetails;

/**
 * Loop pausado por falha de uma iteração (PLAN.md, "modo Loop"). Não é evento de sessão: o loop avisa direto.
 * `message` é o `lastError` do loop.
 */
export interface LoopPausedDetails {
  kind: 'loop_paused';
  sessionId: string;
  message: string;
}

export type NotifyHandler = (sessionId: string, kind: NotifyKind, details: NotifyDetails) => void;

/** Aviso para um evento gravado, ou undefined quando o evento não avisa. */
export function notifyOf(event: SessionEvent): { kind: NotifyKind; details: NotifyDetails } | undefined {
  switch (event.kind) {
    // Turno com stopReason error não é "terminou": o evento `error` gravado logo antes do turno já avisa.
    case 'turn_end':
      return event.stopReason === 'error' ? undefined : { kind: event.kind, details: event };
    case 'permission_request':
    case 'user_question':
    case 'file_request':
    case 'preview':
    case 'error':
    case 'file':
      return { kind: event.kind, details: event };
    case 'terminal_exit':
      return { kind: 'turn_end', details: event };
    default:
      return undefined;
  }
}
