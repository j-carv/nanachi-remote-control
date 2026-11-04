import type { Session, Workspace } from '@nanachi/shared';
import { z } from 'zod';
import { ApiError } from './api.js';
import type { StorageLike } from './machines.js';
import type { Route } from './navigation.js';

export const LAST_ROUTE_KEY = 'nanachi.lastRoute';

const BaseSchema = z.object({ machineId: z.string().min(1) });

/** Rota guardada no localStorage: só ids, nunca os dados do workspace ou da sessão. */
const PersistedRouteSchema = z.discriminatedUnion('kind', [
  BaseSchema.extend({ kind: z.literal('home') }),
  BaseSchema.extend({ kind: z.literal('workspaces') }),
  BaseSchema.extend({ kind: z.literal('folders') }),
  BaseSchema.extend({ kind: z.literal('sessions'), workspaceId: z.string().min(1) }),
  BaseSchema.extend({
    kind: z.literal('chat'),
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  }),
]);

export type PersistedRoute = z.infer<typeof PersistedRouteSchema>;

/** Dados que a reconstrução da pilha precisa do PC. Os erros 404 viram "não existe mais". */
export interface RouteSource {
  listWorkspaces(): Promise<Workspace[]>;
  listSessions(workspaceId: string): Promise<Session[]>;
}

/**
 * Rota ativa em forma persistível. Pareamento não é guardado (é transitório), então devolve null
 * e a última rota real continua salva.
 */
export function toPersistedRoute(machineId: string, route: Route): PersistedRoute | null {
  switch (route.kind) {
    case 'home':
    case 'workspaces':
    case 'folders':
      return { machineId, kind: route.kind };
    case 'sessions':
      return { machineId, kind: 'sessions', workspaceId: route.workspace.id };
    case 'chat':
      return {
        machineId,
        kind: 'chat',
        workspaceId: route.workspace.id,
        sessionId: route.session.id,
      };
    // Alterações e dispositivos são telas de passagem: a última rota salva continua sendo a conversa/lista.
    case 'pair':
    case 'settings':
    case 'devices':
    case 'changes':
      return null;
  }
}

/** Lê a rota salva. Lixo, storage bloqueado ou formato antigo viram null. */
export function readLastRoute(storage: StorageLike): PersistedRoute | null {
  let raw: string | null;
  try {
    raw = storage.getItem(LAST_ROUTE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = PersistedRouteSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Retorna `false` se o storage recusou a escrita. */
export function writeLastRoute(storage: StorageLike, route: PersistedRoute): boolean {
  try {
    storage.setItem(LAST_ROUTE_KEY, JSON.stringify(route));
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'not_found';
}

/**
 * Pilha de telas (da home até o destino) para reabrir a rota salva. Cada nível é conferido no PC;
 * o que sumiu faz a pilha parar no nível válido mais próximo. Outros erros (rede, 401) são
 * relançados: sem resposta do PC, quem chama decide não restaurar nada.
 */
export async function planRestore(saved: PersistedRoute, source: RouteSource): Promise<Route[]> {
  const home: Route[] = [{ kind: 'home' }];
  switch (saved.kind) {
    case 'home':
      return home;
    case 'workspaces':
      return [...home, { kind: 'workspaces' }];
    case 'folders':
      return [...home, { kind: 'workspaces' }, { kind: 'folders' }];
    case 'sessions':
    case 'chat':
      return restoreWorkspaceLevels(saved, source);
  }
}

async function restoreWorkspaceLevels(
  saved: Extract<PersistedRoute, { kind: 'sessions' | 'chat' }>,
  source: RouteSource,
): Promise<Route[]> {
  const workspacesLevel: Route[] = [{ kind: 'home' }, { kind: 'workspaces' }];
  const workspace = (await source.listWorkspaces()).find((item) => item.id === saved.workspaceId);
  if (workspace === undefined) return workspacesLevel;

  const sessionsLevel: Route[] = [...workspacesLevel, { kind: 'sessions', workspace }];
  if (saved.kind === 'sessions') return sessionsLevel;

  try {
    const session = (await source.listSessions(workspace.id)).find((item) => item.id === saved.sessionId);
    if (session === undefined) return sessionsLevel;
    return [...sessionsLevel, { kind: 'chat', workspace, session }];
  } catch (error) {
    if (isNotFound(error)) return workspacesLevel;
    throw error;
  }
}
