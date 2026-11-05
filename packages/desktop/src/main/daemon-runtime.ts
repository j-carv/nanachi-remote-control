import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR_NAME } from '../install/constants.js';

/** Desktop's own port. 7777 is the standalone daemon's (and the supervisor's), so Desktop never defaults to it. */
export const DEFAULT_PORT = 7780;

/** Where Desktop keeps its data; `NANACHI_HOME` belongs to the standalone daemon and is ignored. */
export const DESKTOP_HOME_ENV = 'NANACHI_DESKTOP_HOME';

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

/**
 * Desktop's own data folder: `NANACHI_DESKTOP_HOME`, else `%USERPROFILE%\.nanachi-desktop`. It is NOT the standalone
 * daemon's folder, so `NANACHI_HOME` is never read here. Every caller (daemon host, pairing CLI, tsnet state, the
 * uninstaller, the data-delete guard) goes through this function; Desktop hands the result to the daemon and its CLI
 * as their `NANACHI_HOME`.
 */
export function resolveHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const override = env[DESKTOP_HOME_ENV];
  return override !== undefined && override !== '' ? override : join(home, DATA_DIR_NAME);
}

/**
 * The standalone daemon's data folder named by the environment (`NANACHI_HOME`), when set. Desktop never uses it; the
 * guards of the installer and the uninstaller refuse it (on top of `%USERPROFILE%\.nanachi-remote`, which they always
 * refuse).
 */
export function standaloneHomes(env: NodeJS.ProcessEnv): string[] {
  const value = env.NANACHI_HOME;
  return value !== undefined && value.trim() !== '' ? [value] : [];
}

/**
 * Before a spawn: when `<home>/config.json` does not exist, creates the folder and writes `{ "port": 7780 }` (UTF-8,
 * no BOM, trailing newline); the daemon fills every other default. An existing file, valid or not, is never rewritten
 * (an exclusive create, so a file that shows up meanwhile is safe too): its port wins, and the daemon reports a config
 * error itself. Without this the daemon would create its own config with port 7777, the supervisor's.
 */
export function ensureDesktopConfig(home: string): 'created' | 'kept' {
  mkdirSync(home, { recursive: true });
  try {
    writeFileSync(join(home, 'config.json'), `${JSON.stringify({ port: DEFAULT_PORT }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return 'created';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return 'kept';
    throw error;
  }
}

/**
 * Port the daemon will listen on, read from `<home>/config.json` without creating it (`ensureDesktopConfig` does that).
 * Anything unreadable falls back to Desktop's default, 7780; the daemon reports the real config error in its log.
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
