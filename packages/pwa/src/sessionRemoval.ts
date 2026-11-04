import type { Session, SessionStatus } from '@nanachi/shared';

/**
 * Texto da confirmação de "Remover do app". O histórico continua no agente: só some da tela do app.
 * `agentLabel` é o nome do agente (ex.: "Oh My Pi"), não o id.
 */
export function removalConfirmText(agentLabel: string): string {
  return `Remover esta sessão do app? O histórico continua no ${agentLabel} e você pode trazê-la de volta em Retomar do PC.`;
}

/** Aviso antes de remover: só quando a sessão está trabalhando, esperando permissão ou subindo. Senão, null. */
export function removalInterruptNotice(status: SessionStatus): string | null {
  switch (status) {
    case 'running':
      return 'A sessão está trabalhando. Remover agora interrompe o trabalho.';
    case 'awaiting_permission':
      return 'A sessão está esperando sua permissão. Remover agora interrompe o trabalho.';
    case 'starting':
      return 'A sessão está iniciando. Remover agora interrompe o início.';
    case 'idle':
    case 'stopped':
    case 'error':
      return null;
  }
}

/**
 * Lista que a tela mostra: a do servidor com os broadcasts `session` por cima (o broadcast é mais novo),
 * sem as sessões removidas do app, mais recente primeiro.
 */
export function visibleSessions(
  loaded: readonly Session[],
  live: Readonly<Record<string, Session>>,
  removedIds: ReadonlySet<string>,
): Session[] {
  const byId = new Map(loaded.map((session) => [session.id, session]));
  for (const session of Object.values(live)) byId.set(session.id, session);
  for (const id of removedIds) byId.delete(id);
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
