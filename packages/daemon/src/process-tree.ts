import { spawnSync } from 'node:child_process';

export interface KillResult {
  ok: boolean;
  message: string;
}

/** Argumentos do `taskkill`: a árvore inteira (`/T`), à força (`/F`), pelo pid. Sem shell. */
export function taskkillArgs(pid: number): string[] {
  return ['/T', '/F', '/PID', String(pid)];
}

/** Mata o processo e tudo que ele gerou. No Windows usa `taskkill /T /F`; fora dele, só o pid. */
export function killProcessTree(pid: number): KillResult {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
      return { ok: true, message: '' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }
  const result = spawnSync('taskkill', taskkillArgs(pid), { windowsHide: true, encoding: 'utf8' });
  if (result.error !== undefined) return { ok: false, message: result.error.message };
  return { ok: result.status === 0, message: (result.stderr || result.stdout).trim() };
}
