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
  if (route === undefined) throw new Error('screen stack is empty');
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

/**
 * Wide screens: picking something in the list pane shows that screen right above the first one of the stack, whatever was
 * open (the list is always on screen, so there is no stack of screens to go back through). The depth is 1.
 */
export function selectNav(nav: NavState, route: Route): { nav: NavState; depth: number } {
  const root = nav.routes[0];
  if (root === undefined) throw new Error('screen stack is empty');
  return { nav: { routes: [root, route], index: 1 }, depth: 1 };
}

/**
 * What the browser history does for a navigation that drops screens from the stack (a pick or a reset on a wide screen).
 * `push` and `replace` write one entry; `rewind` goes back `entries` entries first (`history.go(-entries)`), so the
 * entries of the dropped screens do not stay behind as dead steps that Back would have to go through one by one.
 */
export type HistoryStep =
  | { kind: 'push'; depth: number }
  | { kind: 'replace'; depth: number }
  | { kind: 'rewind'; entries: number };

/** The history step of `selectNav`: the entry of the picked screen is the one at depth 1, with the first screen at depth 0. */
export function selectHistoryStep(nav: NavState): HistoryStep {
  if (nav.index === 0) return { kind: 'push', depth: 1 };
  if (nav.index === 1) return { kind: 'replace', depth: 1 };
  return { kind: 'rewind', entries: nav.index - 1 };
}

/** The history step of going back to a stack of the first screen alone (depth 0). */
export function resetHistoryStep(nav: NavState): HistoryStep {
  return nav.index === 0 ? { kind: 'replace', depth: 0 } : { kind: 'rewind', entries: nav.index };
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
