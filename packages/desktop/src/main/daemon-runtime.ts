import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 7777;

/** What it takes to run the daemon or its CLI under a Node 22 (never under Electron's own Node). */
export interface DaemonRuntime {
  /** `node.exe` of the bundled runtime, or just `node` (resolved through PATH) in development. */
  nodePath: string;
  daemonMain: string;
  daemonCli: string;
  cwd: string;
  packaged: boolean;
}

export interface RuntimeInput {
  packaged: boolean;
  /** `process.resourcesPath`: where electron-builder puts `extraResources`. */
  resourcesPath: string;
  /** Root of the monorepo, for development runs. */
  repoRoot: string;
}

function daemonFiles(root: string): { daemonMain: string; daemonCli: string } {
  const dist = join(root, 'packages', 'daemon', 'dist');
  return { daemonMain: join(dist, 'main.js'), daemonCli: join(dist, 'cli.js') };
}

/**
 * Packaged: `resources/runtime/node.exe` runs `resources/runtime/packages/daemon/dist/main.js`, a folder that mirrors
 * the monorepo layout. Development: `node` from PATH runs the daemon build of this repository.
 */
export function resolveRuntime(input: RuntimeInput): DaemonRuntime {
  if (input.packaged) {
    const root = join(input.resourcesPath, 'runtime');
    return { nodePath: join(root, 'node.exe'), ...daemonFiles(root), cwd: root, packaged: true };
  }
  return { nodePath: 'node', ...daemonFiles(input.repoRoot), cwd: input.repoRoot, packaged: false };
}

/** First file the runtime needs that is not on disk, or null. A bare `node` is looked up through PATH at spawn. */
export function missingRuntimeFile(runtime: DaemonRuntime, exists: (path: string) => boolean = existsSync): string | null {
  const needed = runtime.packaged ? [runtime.nodePath] : [];
  for (const path of [...needed, runtime.daemonMain, runtime.daemonCli]) {
    if (!exists(path)) return path;
  }
  return null;
}

/** `NANACHI_HOME` or `%USERPROFILE%\.nanachi-remote`: the same rule as the daemon (`resolveNanachiHome`). */
export function resolveHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  return env.NANACHI_HOME ?? join(home, '.nanachi-remote');
}

/**
 * Port the daemon will listen on, read from `<home>/config.json` without creating it (the daemon does that).
 * Anything unreadable falls back to the default; the daemon reports the real config error in its log.
 */
export function readConfiguredPort(home: string): number {
  try {
    // PowerShell 5.1 writes a BOM; JSON.parse does not accept it.
    const raw: unknown = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8').replace(/^﻿/, ''));
    if (typeof raw === 'object' && raw !== null && 'port' in raw) {
      const port = raw.port;
      if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    }
  } catch {
    // Missing or invalid: default.
  }
  return DEFAULT_PORT;
}
