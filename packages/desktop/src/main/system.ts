import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { ChildLike, HealthInfo, SpawnOptions } from './daemon-host.js';
import type { TsnetChild } from './tsnet-host.js';

/** `/api/health` of a Nanachi daemon: `{ ok: true, machineId, machineName, version }`. Anything else is not one. */
export function parseHealth(json: unknown): HealthInfo | null {
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;
  const { ok, machineId, machineName, version } = record;
  if (ok !== true) return null;
  if (typeof machineId !== 'string' || machineId === '') return null;
  if (typeof machineName !== 'string' || machineName === '') return null;
  if (typeof version !== 'string' || version === '') return null;
  return { machineId, machineName, version };
}

/**
 * What answers on the port. `restricted` is a daemon with `allowedTailscaleLogins` set: it answers every `/api/*` call
 * that has no trusted Tailscale header with `403 {"error":"forbidden"}`, `/api/health` included.
 */
export type HealthProbe = { kind: 'ok'; info: HealthInfo } | { kind: 'restricted' } | { kind: 'none' };

export function classifyHealthResponse(status: number, body: unknown): HealthProbe {
  if (status === 200) {
    const info = parseHealth(body);
    return info === null ? { kind: 'none' } : { kind: 'ok', info };
  }
  if (status === 403 && typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'forbidden') {
    return { kind: 'restricted' };
  }
  return { kind: 'none' };
}

export interface FetchHealthOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Asks the loopback daemon on `port` for its health. Never throws: no answer, a bad answer and a timeout are all `none`. */
export async function fetchHealth(port: number, options: FetchHealthOptions = {}): Promise<HealthProbe> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_500),
    });
    const body: unknown = await response.json().catch(() => null);
    return classifyHealthResponse(response.status, body);
  } catch {
    return { kind: 'none' };
  }
}

/**
 * True when nothing holds `port` on the loopback address: a throwaway server can bind it and let go. This is the check
 * the daemon would fail with `EADDRINUSE`, made before a daemon is spawned into it.
 */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

/** Spawns a hidden process with piped output. Used for the daemon and for the CLI. */
export function spawnHidden(command: string, args: string[], options: SpawnOptions): ChildLike {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Spawns the Tailscale sidecar. Unlike `spawnHidden`, stdin is a pipe that stays open: the sidecar treats EOF on
 * stdin as "stop", so a closed or null stdin would end it at once.
 */
export function spawnSidecar(command: string, args: string[], options: SpawnOptions): TsnetChild {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** `taskkill /T /F /PID`: the process and everything it started. Resolves when taskkill is done; never rejects. */
export function killProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      resolve();
      return;
    }
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs a short-lived hidden process (the daemon CLI) to completion and collects its output. A process that outlives
 * `timeoutMs` is killed with its tree. Resolves for every outcome; it rejects only when the process cannot start.
 */
export function runProcess(
  command: string,
  args: string[],
  options: SpawnOptions,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawnHidden(command, args, options);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void killProcessTree(child.pid);
    }, timeoutMs);
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}
