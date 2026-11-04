import { describe, expect, it } from 'vitest';
import {
  activeRoute,
  depthOf,
  goToDepth,
  initialNav,
  pushNav,
  replaceNav,
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
