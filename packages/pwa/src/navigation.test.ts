import { describe, expect, it } from 'vitest';
import {
  activeRoute,
  depthOf,
  goToDepth,
  initialNav,
  pushNav,
  replaceNav,
  resetHistoryStep,
  selectHistoryStep,
  selectNav,
  type Route,
} from './navigation.js';

const HOME: Route = { kind: 'home' };
const WORKSPACES: Route = { kind: 'workspaces' };
const FOLDERS: Route = { kind: 'folders' };

describe('pilha de telas', () => {
  it('começa com uma tela na profundidade 0', () => {
    const nav = initialNav(HOME);
    expect(nav).toEqual({ routes: [HOME], index: 0 });
    expect(activeRoute(nav)).toBe(HOME);
  });

  it('push adiciona no topo e devolve a nova profundidade', () => {
    const { nav, depth } = pushNav(initialNav(HOME), WORKSPACES);
    expect(depth).toBe(1);
    expect(activeRoute(nav)).toBe(WORKSPACES);
    expect(nav.routes).toEqual([HOME, WORKSPACES]);
  });

  it('push depois de voltar descarta as telas à frente', () => {
    const base = pushNav(pushNav(initialNav(HOME), WORKSPACES).nav, FOLDERS).nav;
    const back = goToDepth(base, 0);
    const { nav } = pushNav(back, WORKSPACES);
    expect(nav.routes).toEqual([HOME, WORKSPACES]);
    expect(nav.index).toBe(1);
  });

  it('replace troca a tela atual sem mudar a profundidade', () => {
    const nav = replaceNav(pushNav(initialNav(HOME), WORKSPACES).nav, FOLDERS);
    expect(nav.index).toBe(1);
    expect(nav.routes).toEqual([HOME, FOLDERS]);
  });

  it('goToDepth limita a profundidade ao intervalo existente', () => {
    const nav = pushNav(initialNav(HOME), WORKSPACES).nav;
    expect(goToDepth(nav, -3).index).toBe(0);
    expect(goToDepth(nav, 9).index).toBe(1);
  });
});

describe('selectNav (telas largas)', () => {
  it('a partir da home, mostra a tela escolhida na profundidade 1', () => {
    const { nav, depth } = selectNav(initialNav(HOME), WORKSPACES);
    expect(depth).toBe(1);
    expect(nav).toEqual({ routes: [HOME, WORKSPACES], index: 1 });
  });

  it('descarta o que estava aberto, mantendo só a primeira tela da pilha', () => {
    const deep = pushNav(pushNav(initialNav(HOME), WORKSPACES).nav, FOLDERS).nav;
    const { nav, depth } = selectNav(deep, WORKSPACES);
    expect(depth).toBe(1);
    expect(nav.routes).toEqual([HOME, WORKSPACES]);
    expect(nav.index).toBe(1);
  });

  it('não muda a pilha recebida', () => {
    const base = pushNav(initialNav(HOME), WORKSPACES).nav;
    selectNav(base, FOLDERS);
    expect(base.routes).toEqual([HOME, WORKSPACES]);
  });
});

describe('browser history after a pick on a wide screen', () => {
  const stack = (depth: number) => {
    let nav = initialNav(HOME);
    for (let level = 0; level < depth; level += 1) nav = pushNav(nav, level % 2 === 0 ? WORKSPACES : FOLDERS).nav;
    return nav;
  };

  it('pushes the first entry when the list pane is the only thing open (nothing to rewind)', () => {
    expect(selectHistoryStep(stack(0))).toEqual({ kind: 'push', depth: 1 });
  });

  it('replaces the entry of the screen that was open, when it was one level deep', () => {
    expect(selectHistoryStep(stack(1))).toEqual({ kind: 'replace', depth: 1 });
  });

  it('rewinds to the entry at depth 1 when screens were pushed on top of the picked one, so no dead entries stay behind', () => {
    expect(selectHistoryStep(stack(2))).toEqual({ kind: 'rewind', entries: 1 });
    expect(selectHistoryStep(stack(3))).toEqual({ kind: 'rewind', entries: 2 });
    expect(selectHistoryStep(stack(5))).toEqual({ kind: 'rewind', entries: 4 });
  });

  it('lands the rewind exactly on the entry at depth 1, the one the picked screen takes over', () => {
    for (const depth of [2, 3, 4, 5]) {
      const step = selectHistoryStep(stack(depth));
      expect(step.kind).toBe('rewind');
      if (step.kind === 'rewind') expect(depth - step.entries).toBe(1);
    }
  });

  it('a reset (another machine) goes back to the first entry', () => {
    expect(resetHistoryStep(stack(0))).toEqual({ kind: 'replace', depth: 0 });
    expect(resetHistoryStep(stack(1))).toEqual({ kind: 'rewind', entries: 1 });
    expect(resetHistoryStep(stack(3))).toEqual({ kind: 'rewind', entries: 3 });
  });
});

describe('depthOf', () => {
  it('lê depth do history.state', () => {
    expect(depthOf({ depth: 2 })).toBe(2);
  });

  it.each([null, undefined, 'x', 3, { depth: -1 }, { depth: 1.5 }, { depth: '1' }, {}])(
    'estado inválido %j vira 0',
    (state) => {
      expect(depthOf(state)).toBe(0);
    },
  );
});
