import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  bootTimeMs,
  isLockLive,
  readLock,
  releaseLock,
  type LockDeps,
} from '../src/supervisor-lock.js';
import { removeTempDir } from './temp.js';

let dir: string;
let lockFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-lock-'));
  lockFile = join(dir, 'supervisor.lock');
});

afterEach(async () => {
  await removeTempDir(dir);
});

/** Relógio fixo: o boot foi 10 min atrás. `nodePids` são os pids que parecem `node.exe`. */
function deps(nodePids: number[], overrides: Partial<LockDeps> = {}): LockDeps {
  const now = Date.parse('2026-11-03T12:00:00.000Z');
  return {
    now: () => now,
    uptimeSeconds: () => 600,
    isNodeProcess: (pid) => nodePids.includes(pid),
    ...overrides,
  };
}

describe('supervisor.lock', () => {
  it('sem arquivo: adquire e grava pid e horário do boot', async () => {
    const d = deps([]);
    expect(acquireLock(lockFile, 4242, d)).toEqual({ ok: true });

    expect(JSON.parse(await readFile(lockFile, 'utf8'))).toEqual({ pid: 4242, bootedAt: bootTimeMs(d) });
  });

  it('lock de processo node vivo no mesmo boot: recusa e informa o dono', async () => {
    const d = deps([111]);
    acquireLock(lockFile, 111, d);

    const second = acquireLock(lockFile, 222, d);

    expect(second).toEqual({ ok: false, owner: { pid: 111, bootedAt: bootTimeMs(d) } });
  });

  it('pid do lock reaproveitado por outro processo (não é node): toma o lock', () => {
    acquireLock(lockFile, 111, deps([111]));
    expect(acquireLock(lockFile, 222, deps([]))).toEqual({ ok: true });
    expect(readLock(lockFile)?.pid).toBe(222);
  });

  it('lock de um boot anterior (máquina reiniciou): é velho mesmo com pid vivo', () => {
    const d = deps([111]);
    const older = { pid: 111, bootedAt: bootTimeMs(d) - 3_600_000 };

    expect(isLockLive(older, d)).toBe(false);
    expect(isLockLive({ pid: 111, bootedAt: bootTimeMs(d) + 5_000 }, d)).toBe(true);
  });

  it('arquivo corrompido não impede de subir', async () => {
    await writeFile(lockFile, 'não é json');
    expect(acquireLock(lockFile, 333, deps([]))).toEqual({ ok: true });
    expect(readLock(lockFile)?.pid).toBe(333);
  });

  it('release só remove o lock do próprio pid', () => {
    acquireLock(lockFile, 111, deps([]));

    releaseLock(lockFile, 999);
    expect(existsSync(lockFile)).toBe(true);

    releaseLock(lockFile, 111);
    expect(existsSync(lockFile)).toBe(false);
  });
});
