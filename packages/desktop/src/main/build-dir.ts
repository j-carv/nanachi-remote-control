import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Overrides the folder that holds the stage and release outputs (tests, another drive). */
export const BUILD_DIR_ENV = 'NANACHI_DESKTOP_BUILD_DIR';

/**
 * Where Desktop builds go: `%LOCALAPPDATA%\nanachi-desktop-build`, never inside the repository. The stage and release
 * folders are about 1 GB (the agents' native binaries alone are ~780 MiB) and the repository lives in OneDrive.
 * `NANACHI_DESKTOP_BUILD_DIR` overrides it; it must be an absolute path.
 */
export function resolveBuildDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const override = env[BUILD_DIR_ENV];
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) throw new Error(`${BUILD_DIR_ENV} precisa ser um caminho absoluto (recebi "${override}")`);
    return resolve(override);
  }
  const localAppData = env.LOCALAPPDATA;
  const base = localAppData !== undefined && localAppData !== '' ? localAppData : join(home, 'AppData', 'Local');
  return join(base, 'nanachi-desktop-build');
}

/** Throws when `buildDir` is the repository or inside it: build outputs must stay out of OneDrive. */
export function assertOutsideRepo(repoRoot: string, buildDir: string): void {
  const rel = relative(resolve(repoRoot), resolve(buildDir));
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside) throw new Error(`recusado: a pasta de build ${buildDir} fica dentro do repositório (${repoRoot})`);
}

/** The runtime folder that gets packaged (`stage\runtime`) and the sidecar (`stage\bin`) live here. */
export function stageDirOf(buildDir: string): string {
  return join(buildDir, 'stage');
}

/** electron-builder output (`release\win-unpacked`). */
export function releaseDirOf(buildDir: string): string {
  return join(buildDir, 'release');
}
