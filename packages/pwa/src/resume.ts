import type { AgentSessionSummary } from '@nanachi/shared';
import { ApiError } from './api.js';
import { formatRelativeTime } from './relativeTime.js';

/** Agentes que aceitam "Retomar do PC": só ACP. Terminal não lista sessões do agente. */
export function resumableAgents<T extends { kind: 'acp' | 'pty' }>(agents: readonly T[]): T[] {
  return agents.filter((agent) => agent.kind === 'acp');
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Data e hora locais: "03/11/2026 às 09:05". */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const day = `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)}/${date.getFullYear()}`;
  return `${day} às ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Nome da sessão na lista: o título do agente, ou "Sessão de <data e hora>" quando o agente não deu título. */
export function listedTitle(item: Pick<AgentSessionSummary, 'title' | 'updatedAt'>): string {
  if (item.title !== null) return item.title;
  if (item.updatedAt === null) return 'Sessão sem título';
  return `Sessão de ${formatDateTime(item.updatedAt)}`;
}

/** Tempo relativo da última atividade ("há 30 min"); null sem data. */
export function sessionAgeText(updatedAt: number | null, now: number): string | null {
  return updatedAt === null ? null : formatRelativeTime(updatedAt, now);
}

/** Texto de carregamento da listagem: o agente sobe no PC, o que pode levar alguns segundos. */
export function listingText(agentLabel: string): string {
  return `Abrindo o ${agentLabel} no PC… pode levar alguns segundos`;
}

/** Texto enquanto o histórico reenviado pelo agente é gravado no app. */
export const IMPORTING_TEXT = 'Importando histórico…';

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
