import type { SessionStatus } from '@nanachi/shared';

/** Título que o daemon usa até o primeiro prompt (sessão PTY nunca ganha um). */
export const DEFAULT_SESSION_TITLE = 'Nova sessão';

const STATUS_TEXT: Record<SessionStatus, string> = {
  starting: 'Iniciando',
  idle: 'Pronta',
  running: 'Trabalhando',
  awaiting_permission: 'Aguarda permissão',
  stopped: 'Encerrada',
  error: 'Erro',
};

/** Texto da pílula de status. Em terminal (PTY) "rodando" é "Em execução", não "Trabalhando". */
export function sessionStatusText(status: SessionStatus, kind: 'acp' | 'pty'): string {
  if (status === 'running' && kind === 'pty') return 'Em execução';
  return STATUS_TEXT[status];
}

/**
 * Título para mostrar. Terminal sem título (o padrão) vira "<agente> · terminal", porque
 * não há primeiro prompt para dar nome à sessão.
 */
export function sessionTitle(
  session: { title: string; kind: 'acp' | 'pty' },
  agentLabel: string,
): string {
  if (session.kind === 'pty' && session.title === DEFAULT_SESSION_TITLE) {
    return `${agentLabel} · terminal`;
  }
  return session.title;
}
