import { spawn as nodeSpawn } from 'node:child_process';
import { t } from '../common/i18n/index.js';
import { messageOf } from '../common/message.js';
import { powershellPath, systemDirectory } from '../common/system-paths.js';
import { UNINSTALL_ARG } from '../install/constants.js';

/** Environment variable that carries the path of `Nanachi.exe` to the PowerShell below. */
export const UNINSTALL_EXE_ENV = 'NANACHI_UNINSTALL_EXE';

/**
 * `Start-Process` makes the uninstaller a child of PowerShell, which exits at once, and not of the running app. That
 * matters: the uninstaller stops a running Nanachi with `taskkill /T /F`, which also kills that process's children, and
 * the uninstaller would be one of them. The path goes through the environment so spaces and accents never touch the
 * command line.
 */
export const UNINSTALL_LAUNCH_SCRIPT = `Start-Process -FilePath $env:${UNINSTALL_EXE_ENV} -ArgumentList '${UNINSTALL_ARG}'`;

interface LaunchChild {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  unref(): void;
}

export type LaunchSpawn = (
  command: string,
  args: string[],
  options: { cwd: string; windowsHide: true; stdio: 'ignore'; env: NodeJS.ProcessEnv },
) => LaunchChild;

export interface LaunchUninstallerOptions {
  /** `process.execPath` of the installed app. */
  execPath: string;
  spawn?: LaunchSpawn;
  env?: NodeJS.ProcessEnv;
  /** A message fit for the user when the uninstaller could not be started. */
  onError(message: string): void;
}

/**
 * Starts `Nanachi.exe --uninstall` (its own window asks for confirmation). Never throws, and reports a failure once: a
 * PowerShell that cannot start, or that exits with an error code (`Start-Process` could not run the program). The
 * PowerShell is the absolute system one, run from `System32`: a bare name is looked up in the working directory first.
 * It is not detached on purpose: a detached (console-less) PowerShell could not start the console programs a test stands
 * in with, and it gains nothing, since it exits as soon as the uninstaller is running.
 */
export function launchUninstaller(options: LaunchUninstallerOptions): void {
  const spawn: LaunchSpawn = options.spawn ?? nodeSpawn;
  const env = options.env ?? process.env;
  let reported = false;
  const fail = (error: unknown): void => {
    if (reported) return;
    reported = true;
    options.onError(t('main.uninstallLaunch.failed', { detail: messageOf(error) }));
  };
  try {
    const child = spawn(powershellPath(env), ['-NoProfile', '-NonInteractive', '-Command', UNINSTALL_LAUNCH_SCRIPT], {
      cwd: systemDirectory(env),
      windowsHide: true,
      stdio: 'ignore',
      env: { ...env, [UNINSTALL_EXE_ENV]: options.execPath },
    });
    child.on('error', fail);
    child.on('exit', (code) => {
      if (code !== 0) fail(code === null ? t('main.uninstallLaunch.exitedWithError') : t('main.uninstallLaunch.exitedWithCode', { code }));
    });
    child.unref();
  } catch (error) {
    fail(error);
  }
}
