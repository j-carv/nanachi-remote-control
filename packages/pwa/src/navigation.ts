import type { Session, Workspace } from '@nanachi/shared';

/**
 * Telas do app. Só a do topo é renderizada; a pilha guarda as anteriores para o
 * `history.state.depth` do navegador reconstruir a tela certa no gesto de voltar do iOS.
 */
export type Route =
  | { kind: 'home' }
  | { kind: 'pair'; baseUrl: string | null }
  | { kind: 'settings' }
  | { kind: 'workspaces' }
  | { kind: 'folders' }
  | { kind: 'devices' }
  | { kind: 'sessions'; workspace: Workspace }
  | { kind: 'chat'; workspace: Workspace; session: Session }
  | { kind: 'changes'; workspace: Workspace; session: Session }
  /** Explorador de arquivos do workspace. `path` é a pasta aberta, relativa à raiz ("" = raiz). */
  | { kind: 'files'; workspace: Workspace; path: string }
  /** Editor de um arquivo de texto do workspace. `path` é relativo à raiz do workspace. */
  | { kind: 'editor'; workspace: Workspace; path: string };

export interface NavState {
  readonly routes: readonly Route[];
  readonly index: number;
}

/** Ações de navegação expostas às telas. `back` usa history.back(), o popstate faz o resto. */
export interface Navigator {
  push(route: Route): void;
  back(): void;
  replace(route: Route): void;
}

export function initialNav(route: Route): NavState {
  return { routes: [route], index: 0 };
}

export function activeRoute(nav: NavState): Route {
  const route = nav.routes[nav.index];
  if (route === undefined) throw new Error('pilha de telas vazia');
  return route;
}

/** Empilha uma tela; descarta as que estavam à frente. `depth` vai no history.state. */
export function pushNav(nav: NavState, route: Route): { nav: NavState; depth: number } {
  const index = nav.index + 1;
  return {
    nav: { routes: [...nav.routes.slice(0, index), route], index },
    depth: index,
  };
}

/** Troca a tela atual (mesma profundidade). */
export function replaceNav(nav: NavState, route: Route): NavState {
  return { routes: [...nav.routes.slice(0, nav.index), route], index: nav.index };
}

/** Vai para a profundidade indicada, limitada às telas que existem. */
export function goToDepth(nav: NavState, depth: number): NavState {
  const index = Math.min(Math.max(depth, 0), nav.routes.length - 1);
  return { routes: nav.routes, index };
}

/** Profundidade guardada no `history.state`; qualquer coisa inválida vira 0. */
export function depthOf(state: unknown): number {
  if (typeof state !== 'object' || state === null || !('depth' in state)) return 0;
  const depth = state.depth;
  return typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 ? depth : 0;
}
