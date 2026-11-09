import type { Session, Workspace } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import {
  LAST_ROUTE_KEY,
  planRestore,
  readLastRoute,
  toPersistedRoute,
  writeLastRoute,
  type PersistedRoute,
  type RouteSource,
} from './lastRoute.js';
import type { StorageLike } from './machines.js';
import type { Route } from './navigation.js';

const WORKSPACE: Workspace = { id: 'w-1', name: 'app', path: 'C:\\app', createdAt: 1, muted: false };
const SESSION: Session = {
  id: 's-1',
  workspaceId: 'w-1',
  agent: 'omp',
  kind: 'acp',
  title: 'Nova sessão',
  status: 'stopped',
  accountId: null,
  worktree: null,
  createdAt: 1,
  updatedAt: 1,
};

const HOME: Route = { kind: 'home' };
const WORKSPACES: Route = { kind: 'workspaces' };

interface SourceOptions {
  workspaces?: Workspace[];
  sessions?: Session[];
  listWorkspacesError?: unknown;
  fetchSessionError?: unknown;
}

/** Fonte fake: listas fixas; erros simulam rede ou 404. */
function sourceWith(options: SourceOptions): RouteSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listWorkspaces() {
      calls.push('listWorkspaces');
      if (options.listWorkspacesError !== undefined) throw options.listWorkspacesError;
      return options.workspaces ?? [WORKSPACE];
    },
    async fetchSession(sessionId) {
      calls.push(`fetchSession:${sessionId}`);
      if (options.fetchSessionError !== undefined) throw options.fetchSessionError;
      const session = (options.sessions ?? [SESSION]).find((item) => item.id === sessionId);
      if (session === undefined) throw new ApiError('not_found', 404);
      return session;
    },
  };
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const CHAT: PersistedRoute = {
  machineId: 'm-1',
  kind: 'chat',
  workspaceId: 'w-1',
  sessionId: 's-1',
};

describe('toPersistedRoute', () => {
  it('guarda ids de workspace e sessão da tela de chat', () => {
    expect(toPersistedRoute('m-1', { kind: 'chat', workspace: WORKSPACE, session: SESSION })).toEqual(
      CHAT,
    );
  });

  it('guarda o workspace da tela de sessões', () => {
    expect(toPersistedRoute('m-1', { kind: 'sessions', workspace: WORKSPACE })).toEqual({
      machineId: 'm-1',
      kind: 'sessions',
      workspaceId: 'w-1',
    });
  });

  it('home, workspaces e pastas não guardam ids extras', () => {
    expect(toPersistedRoute('m-1', HOME)).toEqual({ machineId: 'm-1', kind: 'home' });
    expect(toPersistedRoute('m-1', WORKSPACES)).toEqual({ machineId: 'm-1', kind: 'workspaces' });
    expect(toPersistedRoute('m-1', { kind: 'folders' })).toEqual({ machineId: 'm-1', kind: 'folders' });
  });

  it('pareamento é transitório e não é guardado', () => {
    expect(toPersistedRoute('m-1', { kind: 'pair', baseUrl: null })).toBeNull();
  });

  it('ajustes são transitórios (não são guardados; a última rota real continua salva)', () => {
    expect(toPersistedRoute('m-1', { kind: 'settings' })).toBeNull();
  });

  it('o histórico de commits e um commit são telas de passagem, como as alterações', () => {
    expect(toPersistedRoute('m-1', { kind: 'commits', workspace: WORKSPACE, session: SESSION })).toBeNull();
    expect(
      toPersistedRoute('m-1', { kind: 'commit', workspace: WORKSPACE, session: SESSION, hash: 'af9384e' }),
    ).toBeNull();
  });
});

describe('readLastRoute / writeLastRoute', () => {
  it('ida e volta pelo localStorage na chave nanachi.lastRoute', () => {
    const storage = memoryStorage();
    expect(writeLastRoute(storage, CHAT)).toBe(true);
    expect(storage.getItem(LAST_ROUTE_KEY)).toBe(JSON.stringify(CHAT));
    expect(readLastRoute(storage)).toEqual(CHAT);
  });

  it('sem nada salvo devolve null', () => {
    expect(readLastRoute(memoryStorage())).toBeNull();
  });

  it.each([
    '{não é json',
    '{"machineId":"m-1","kind":"desconhecido"}',
    '{"machineId":"m-1","kind":"chat","workspaceId":"w-1"}',
    '[]',
    '"x"',
  ])('lixo no storage (%s) vira null, nunca exceção', (raw) => {
    expect(readLastRoute(memoryStorage({ [LAST_ROUTE_KEY]: raw }))).toBeNull();
  });

  it('storage que lança na leitura vira null', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(readLastRoute(storage)).toBeNull();
  });

  it('storage que recusa a escrita devolve false', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(writeLastRoute(storage, CHAT)).toBe(false);
  });
});

describe('planRestore', () => {
  it('home volta só para a home, sem consultar o PC', async () => {
    const source = sourceWith({});
    const stack = await planRestore({ machineId: 'm-1', kind: 'home' }, source);
    expect(stack).toEqual([HOME]);
    expect(source.calls).toEqual([]);
  });

  it('workspaces reconstrói home → workspaces', async () => {
    const stack = await planRestore({ machineId: 'm-1', kind: 'workspaces' }, sourceWith({}));
    expect(stack).toEqual([HOME, WORKSPACES]);
  });

  it('pastas reconstrói home → workspaces → pastas', async () => {
    const stack = await planRestore({ machineId: 'm-1', kind: 'folders' }, sourceWith({}));
    expect(stack).toEqual([HOME, WORKSPACES, { kind: 'folders' }]);
  });

  it('sessões com workspace existente reconstrói a pilha até a lista de sessões', async () => {
    const stack = await planRestore(
      { machineId: 'm-1', kind: 'sessions', workspaceId: 'w-1' },
      sourceWith({}),
    );
    expect(stack).toEqual([HOME, WORKSPACES, { kind: 'sessions', workspace: WORKSPACE }]);
  });

  it('chat com workspace e sessão existentes reconstrói home → workspaces → sessões → chat', async () => {
    const stack = await planRestore(CHAT, sourceWith({}));
    expect(stack).toEqual([
      HOME,
      WORKSPACES,
      { kind: 'sessions', workspace: WORKSPACE },
      { kind: 'chat', workspace: WORKSPACE, session: SESSION },
    ]);
  });

  it('workspace removido cai para a lista de workspaces', async () => {
    const stack = await planRestore(CHAT, sourceWith({ workspaces: [] }));
    expect(stack).toEqual([HOME, WORKSPACES]);
  });

  it('sessão removida cai para a lista de sessões do workspace', async () => {
    const stack = await planRestore(CHAT, sourceWith({ sessions: [] }));
    expect(stack).toEqual([HOME, WORKSPACES, { kind: 'sessions', workspace: WORKSPACE }]);
  });

  it('404 ao abrir uma sessão removida cai para as sessões do workspace', async () => {
    const stack = await planRestore(
      CHAT,
      sourceWith({ fetchSessionError: new ApiError('not_found', 404) }),
    );
    expect(stack).toEqual([HOME, WORKSPACES, { kind: 'sessions', workspace: WORKSPACE }]);
  });

  it('erro que não é 404 (rede, 401) é propagado para quem decide o que fazer', async () => {
    const network = new ApiError('network');
    await expect(planRestore(CHAT, sourceWith({ listWorkspacesError: network }))).rejects.toBe(
      network,
    );
  });
});
