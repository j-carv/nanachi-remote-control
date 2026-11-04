import { z } from 'zod';
import type { PersistedRoute } from '../lastRoute.js';

/** Sessão para onde a notificação leva. */
export interface SessionTarget {
  machineId: string;
  workspaceId: string;
  sessionId: string;
}

/** Mensagem que o service worker manda à janela aberta no clique da notificação. */
export const OPEN_SESSION_MESSAGE = 'open-session';

const TargetSchema = z.object({
  machineId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
});

const OpenSessionMessageSchema = TargetSchema.extend({ type: z.literal(OPEN_SESSION_MESSAGE) });

/** URL do app que abre a sessão: `/?machine=..&workspace=..&session=..`. */
export function buildSessionUrl(target: SessionTarget): string {
  const params = new URLSearchParams({
    machine: target.machineId,
    workspace: target.workspaceId,
    session: target.sessionId,
  });
  return `/?${params.toString()}`;
}

/** Lê o alvo da query da URL de abertura; qualquer parâmetro faltando ou vazio = sem alvo. */
export function parseSessionSearch(search: string): SessionTarget | null {
  const params = new URLSearchParams(search);
  const parsed = TargetSchema.safeParse({
    machineId: params.get('machine'),
    workspaceId: params.get('workspace'),
    sessionId: params.get('session'),
  });
  return parsed.success ? parsed.data : null;
}

/** Mensagem `open-session` do service worker, ou null se for outra coisa. */
export function parseOpenSessionMessage(data: unknown): SessionTarget | null {
  const parsed = OpenSessionMessageSchema.safeParse(data);
  if (!parsed.success) return null;
  const { machineId, workspaceId, sessionId } = parsed.data;
  return { machineId, workspaceId, sessionId };
}

/** Rota de chat (mesmo formato do lastRoute) para reabrir a sessão pelo caminho de restauração. */
export function targetRoute(target: SessionTarget): PersistedRoute {
  return {
    machineId: target.machineId,
    kind: 'chat',
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
  };
}

/** Alvo guardado em `notification.data` (o que o clique da notificação devolve ao service worker). */
export function parseSessionTarget(data: unknown): SessionTarget | null {
  const parsed = TargetSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
