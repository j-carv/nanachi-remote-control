import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';

/**
 * Lock de instância única do supervisor: `supervisor.lock` com `{ pid, bootedAt }`. `bootedAt` é o horário do boot
 * da máquina na hora da gravação: depois de reiniciar o PC o lock é velho, mesmo que o pid tenha sido reaproveitado.
 */
export interface LockRecord {
  pid: number;
  bootedAt: number;
}

export interface LockDeps {
  now(): number;
  uptimeSeconds(): number;
  /** O pid pertence a um node.exe em execução? */
  isNodeProcess(pid: number): boolean;
}

/** Folga entre o boot gravado e o atual (o relógio pode ajustar alguns segundos). */
const BOOT_TOLERANCE_MS = 60_000;

export type AcquireResult = { ok: true } | { ok: false; owner: LockRecord };

export function bootTimeMs(deps: Pick<LockDeps, 'now' | 'uptimeSeconds'>): number {
  return deps.now() - deps.uptimeSeconds() * 1000;
}

export function isLockLive(record: LockRecord, deps: LockDeps): boolean {
  return Math.abs(record.bootedAt - bootTimeMs(deps)) <= BOOT_TOLERANCE_MS && deps.isNodeProcess(record.pid);
}

/** Lock lido do disco. Arquivo ausente ou inválido vira `undefined`. */
export function readLock(file: string): LockRecord | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw !== 'object' || raw === null) return undefined;
    if (!('pid' in raw) || typeof raw.pid !== 'number') return undefined;
    if (!('bootedAt' in raw) || typeof raw.bootedAt !== 'number') return undefined;
    return { pid: raw.pid, bootedAt: raw.bootedAt };
  } catch {
    return undefined;
  }
}

/** Toma o lock se não há dono vivo. Lock velho (boot anterior, pid que não é node, arquivo corrompido) é substituído. */
export function acquireLock(file: string, pid: number, deps: LockDeps): AcquireResult {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = readLock(file);
    if (existing !== undefined && isLockLive(existing, deps)) return { ok: false, owner: existing };
    rmSync(file, { force: true });
    try {
      writeFileSync(file, JSON.stringify({ pid, bootedAt: bootTimeMs(deps) }), { flag: 'wx' });
      return { ok: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`não foi possível gravar ${file}`);
}

/** Remove o lock, mas só se ele ainda for do pid informado. */
export function releaseLock(file: string, pid: number): void {
  if (readLock(file)?.pid === pid) rmSync(file, { force: true });
}

/** Dependências reais: relógio, uptime e `tasklist` (Windows) para saber se o pid é um node.exe. */
export function defaultLockDeps(): LockDeps {
  return {
    now: () => Date.now(),
    uptimeSeconds: () => uptime(),
    isNodeProcess: isNodeProcess,
  };
}

function isNodeProcess(pid: number): boolean {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.toLowerCase().includes('"node.exe"');
}
