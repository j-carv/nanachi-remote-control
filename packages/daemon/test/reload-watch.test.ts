import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db.js';
import { fingerprintDirs, RELOAD_QUIET_MS, ReloadWatcher, RELOAD_POLL_MS, type ReloadWatchDeps } from '../src/reload-watch.js';
import { countBusySessions, insertSession, insertWorkspace } from '../src/repository.js';
import { removeTempDir } from './temp.js';

/**
 * Harness com estado em `s`: `s.build` é o fingerprint atual (diferente de 'v1' = build mudou), `s.busy` é o
 * número de sessões ativas, `fire()` simula uma mudança de arquivo nas pastas observadas.
 */
function harness(overrides: Partial<ReloadWatchDeps> = {}): {
  deps: ReloadWatchDeps;
  s: { logs: string[]; reloads: number; busy: number; build: string };
  fire(): void;
} {
  const s = { logs: [] as string[], reloads: 0, busy: 0, build: 'v1' };
  const listeners: Array<() => void> = [];
  const deps: ReloadWatchDeps = {
    dirs: ['/dist/daemon', '/dist/shared'],
    busyCount: () => s.busy,
    reload: () => {
      s.reloads += 1;
    },
    log: (message) => s.logs.push(message),
    fingerprint: () => s.build,
    watch: (_dir, onChange) => {
      listeners.push(onChange);
      return { close: () => undefined };
    },
    ...overrides,
  };
  return {
    deps,
    s,
    fire: () => {
      for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReloadWatcher', () => {
  it('período padrão de silêncio é 60 s', () => {
    expect(RELOAD_QUIET_MS).toBe(60_000);
  });

  it('mudança de build sem sessão ativa recarrega só depois de 60 s sem mudanças', () => {
    const h = harness();
    new ReloadWatcher(h.deps).start();

    h.s.build = 'v2';
    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS - 1);
    expect(h.s.reloads).toBe(0);

    vi.advanceTimersByTime(1);
    expect(h.s.reloads).toBe(1);
    expect(h.s.logs).toEqual(expect.arrayContaining([expect.stringMatching(/^reload pendente/), 'recarregando']));
  });

  it('cada mudança reinicia o silêncio: rajada só recarrega 60 s depois da última', () => {
    const h = harness();
    new ReloadWatcher(h.deps).start();
    h.s.build = 'v2';

    h.fire();
    vi.advanceTimersByTime(40_000);
    h.fire();
    vi.advanceTimersByTime(40_000);
    h.fire();

    vi.advanceTimersByTime(RELOAD_QUIET_MS - 1);
    expect(h.s.reloads).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.s.reloads).toBe(1);
  });

  it('reloadQuietMs configurado vale no lugar dos 60 s', () => {
    const h = harness({ quietMs: 5000 });
    new ReloadWatcher(h.deps).start();
    h.s.build = 'v2';
    h.fire();

    vi.advanceTimersByTime(4999);
    expect(h.s.reloads).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.s.reloads).toBe(1);
  });

  it('sessão running bloqueia: fica pendente, loga a contagem e recarrega quando não há mais sessão ativa', () => {
    const h = harness();
    new ReloadWatcher(h.deps).start();
    h.s.build = 'v2';
    h.s.busy = 2;

    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS);
    expect(h.s.reloads).toBe(0);
    expect(h.s.logs).toContain('reload pendente: aguardando 2 sessões ativas');

    vi.advanceTimersByTime(RELOAD_POLL_MS * 5);
    expect(h.s.reloads).toBe(0);

    h.s.busy = 0;
    vi.advanceTimersByTime(RELOAD_POLL_MS);
    expect(h.s.reloads).toBe(1);
    expect(h.s.logs.at(-1)).toBe('recarregando');
  });

  it('sessão que termina antes do silêncio não encurta a espera: o reload ainda vem 60 s depois da mudança', () => {
    const h = harness();
    new ReloadWatcher(h.deps).start();
    h.s.build = 'v2';
    h.s.busy = 1;
    h.fire();

    vi.advanceTimersByTime(10_000);
    h.s.busy = 0;
    vi.advanceTimersByTime(RELOAD_QUIET_MS - 10_000 - 1);
    expect(h.s.reloads).toBe(0);

    vi.advanceTimersByTime(1);
    expect(h.s.reloads).toBe(1);
  });

  it('mudança enquanto espera sessão ativa reinicia o silêncio: não recarrega antes de 60 s da última mudança', () => {
    const h = harness();
    new ReloadWatcher(h.deps).start();
    h.s.build = 'v2';
    h.s.busy = 1;
    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS);

    vi.advanceTimersByTime(30_000);
    h.fire();
    h.s.busy = 0;
    vi.advanceTimersByTime(RELOAD_POLL_MS * 3);
    expect(h.s.reloads).toBe(0);

    vi.advanceTimersByTime(RELOAD_QUIET_MS - RELOAD_POLL_MS * 3 - 1);
    expect(h.s.reloads).toBe(0);
    vi.advanceTimersByTime(1);
    expect(h.s.reloads).toBe(1);
  });

  it('build igual ao de partida (tsc reescreveu o mesmo conteúdo) não recarrega nem loga', () => {
    const h = harness();
    new ReloadWatcher(h.deps).start();

    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS + RELOAD_POLL_MS * 3);

    expect(h.s.reloads).toBe(0);
    expect(h.s.logs).toEqual([]);
  });

  it('mudança revertida enquanto espera sessão ativa cancela o reload pendente', () => {
    const h = harness();
    new ReloadWatcher(h.deps).start();
    h.s.build = 'v2';
    h.s.busy = 1;
    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS);

    h.s.build = 'v1';
    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS);
    h.s.busy = 0;
    vi.advanceTimersByTime(RELOAD_POLL_MS * 3);

    expect(h.s.reloads).toBe(0);
  });

  it('stop cancela tudo: nada mais recarrega depois', () => {
    const h = harness();
    const watcher = new ReloadWatcher(h.deps);
    watcher.start();
    h.s.build = 'v2';
    h.s.busy = 1;
    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS);

    watcher.stop();
    h.s.busy = 0;
    vi.advanceTimersByTime(RELOAD_POLL_MS * 10);

    expect(h.s.reloads).toBe(0);
  });

  it('reload roda uma vez só, mesmo com novas mudanças depois dele', () => {
    const h = harness();
    new ReloadWatcher(h.deps).start();
    h.s.build = 'v2';
    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS);

    h.fire();
    vi.advanceTimersByTime(RELOAD_QUIET_MS + RELOAD_POLL_MS * 2);

    expect(h.s.reloads).toBe(1);
  });

  it('diretório que não existe vira aviso no log, sem derrubar o daemon', () => {
    const h = harness({
      watch: () => {
        throw new Error('ENOENT: no such file');
      },
    });
    const watcher = new ReloadWatcher(h.deps);

    expect(() => watcher.start()).not.toThrow();
    expect(h.s.logs.some((line) => line.includes('ENOENT'))).toBe(true);
  });
});

describe('fingerprintDirs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanachi-fp-'));
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it('muda quando o conteúdo de um arquivo muda, inclusive nas subpastas', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'a.js'), 'x');
    await writeFile(join(dir, 'sub', 'b.js'), 'y');
    const before = fingerprintDirs([dir]);

    await writeFile(join(dir, 'sub', 'b.js'), 'z');

    expect(fingerprintDirs([dir])).not.toBe(before);
  });

  it('não muda quando o arquivo é reescrito com o mesmo conteúdo', async () => {
    await writeFile(join(dir, 'a.js'), 'x');
    const before = fingerprintDirs([dir]);

    await writeFile(join(dir, 'a.js'), 'x');

    expect(fingerprintDirs([dir])).toBe(before);
  });

  it('pasta inexistente conta como vazia', () => {
    expect(fingerprintDirs([join(dir, 'nao-existe')])).toBe(fingerprintDirs([]));
  });
});

describe('countBusySessions', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nanachi-busy-'));
    db = openDatabase(join(dir, 'data.db'));
    insertWorkspace(db, { id: 'w1', name: 'p', path: join(dir, 'p'), createdAt: 1, muted: false });
  });

  afterEach(async () => {
    db.close();
    await removeTempDir(dir);
  });

  it('conta starting, running e awaiting_permission; idle, stopped e error não contam', () => {
    const statuses = ['starting', 'running', 'awaiting_permission', 'idle', 'stopped', 'error'] as const;
    for (const [i, status] of statuses.entries()) {
      insertSession(db, { id: `s${i}`, workspaceId: 'w1', agent: 'omp', title: 't', status, createdAt: 1 });
    }

    expect(countBusySessions(db)).toBe(3);
  });
});
