import type { AgentSessionSummary } from '@nanachi/shared';
import { ApiError } from './api.js';
import { formatRelativeTime } from './relativeTime.js';

/** Agentes que aceitam "Retomar do PC": só ACP. Terminal não lista sessões do agente. */
export function resumableAgents<T extends { kind: 'acp' | 'pty' }>(agents: readonly T[]): T[] {
  return agents.filter((agent) => agent.kind === 'acp');
}

/** Tempo relativo da última atividade ("há 30 min"); null sem data. */
export function sessionAgeText(updatedAt: number | null, now: number): string | null {
  return updatedAt === null ? null : formatRelativeTime(updatedAt, now);
}

/**
 * Sessão do app a abrir quando a importação responde 409 (a sessão já está ligada a uma do app).
 * Null quando o erro não é esse caso: aí a tela mostra o erro normal.
 */
export function conflictSessionId(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.kind !== 'already_running' && error.kind !== 'already_linked') return null;
  return error.sessionId;
}

/** Junta a página seguinte à lista, sem repetir sessão (a ordem recebida vale). */
export function appendListing(
  current: readonly AgentSessionSummary[],
  next: readonly AgentSessionSummary[],
): AgentSessionSummary[] {
  const seen = new Set(current.map((item) => item.acpSessionId));
  const fresh = next.filter((item) => !seen.has(item.acpSessionId));
  return [...current, ...fresh];
}
