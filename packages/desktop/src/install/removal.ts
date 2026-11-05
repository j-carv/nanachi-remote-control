import { spawn } from 'node:child_process';

/**
 * Characters that `cmd.exe` would expand or treat as syntax even inside quotes: such a path is never scheduled. `%` and
 * `!` are the expansion characters (`!` only under delayed expansion, which `/v:off` also switches off).
 */
const UNSAFE_FOR_CMD = /[%!"\r\n\0]/;

export function assertSafeForCmd(path: string): void {
  if (UNSAFE_FOR_CMD.test(path)) throw new Error(`caminho não suportado para remoção agendada: ${path}`);
}

/**
 * One `for /l` loop per folder: while the folder exists, try `rmdir /s /q` and wait a second. A running exe cannot delete
 * itself, so the uninstaller exits and this loop (up to about 30 s) removes what it held.
 */
export function buildRemovalScript(dirs: readonly string[]): string {
  for (const dir of dirs) assertSafeForCmd(dir);
  return dirs
    .map((dir) => `for /l %i in (1,1,30) do if exist "${dir}" (rmdir /s /q "${dir}" 2>nul & ping -n 2 127.0.0.1 >nul)`)
    .join(' & ');
}

/**
 * Arguments of the detached `cmd.exe`. `/v:off` switches delayed expansion off whatever the machine's registry says
 * (`!` would otherwise expand inside the quoted paths), `/d` ignores AutoRun commands, `/s` makes the outer quotes the
 * ones `cmd` strips.
 */
export function removalCommandArgs(dirs: readonly string[]): string[] {
  return ['/v:off', '/d', '/s', '/c', `"${buildRemovalScript(dirs)}"`];
}

/** Starts the removal loop as a detached hidden `cmd.exe` that outlives this process. */
export function scheduleRemoval(dirs: readonly string[]): void {
  const child = spawn('cmd.exe', removalCommandArgs(dirs), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  child.unref();
}
