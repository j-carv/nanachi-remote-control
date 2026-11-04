import type { SessionEvent } from '@nanachi/shared';

/**
 * Momentos em que algo pede atenção do usuário. Hoje ninguém escuta: a fase de Web Push liga um handler
 * (ServerDeps.onNotify) que envia a notificação. Até lá o callback é opcional e não faz nada.
 */
export type NotifyKind = 'turn_end' | 'permission_request' | 'error' | 'file';

/**
 * O próprio evento gravado, já estreitado para os tipos que avisam. `terminal_exit` (fim de sessão PTY) avisa
 * como `turn_end`: o notificador distingue pelo detalhe.
 */
export type NotifyDetails = Extract<SessionEvent, { kind: NotifyKind | 'terminal_exit' }>;

export type NotifyHandler = (sessionId: string, kind: NotifyKind, details: NotifyDetails) => void;

/** Aviso para um evento gravado, ou undefined quando o evento não avisa. */
export function notifyOf(event: SessionEvent): { kind: NotifyKind; details: NotifyDetails } | undefined {
  switch (event.kind) {
    case 'turn_end':
    case 'permission_request':
    case 'error':
    case 'file':
      return { kind: event.kind, details: event };
    case 'terminal_exit':
      return { kind: 'turn_end', details: event };
    default:
      return undefined;
  }
}
