import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { APP_USER_MODEL_ID, EXE_NAME, PRODUCT_NAME, PUBLISHER, RUN_KEY, UNINSTALL_ARG, UNINSTALL_KEY } from './constants.js';

/** One `reg.exe` invocation, as an argument list (never a shell string: paths hold spaces and accents). */
export type RegArgs = string[];

export interface UninstallEntry {
  installDir: string;
  version: string;
  /** Shown by Windows next to the app; optional. */
  estimatedSizeKb?: number;
}

function addValue(name: string, type: 'REG_SZ' | 'REG_DWORD', data: string): RegArgs {
  return ['add', UNINSTALL_KEY, '/v', name, '/t', type, '/d', data, '/f'];
}

/**
 * The per-user "Apps" entry: `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nanachi`. `UninstallString`
 * runs the installed exe with `--uninstall`; the quotes around the path are part of the value.
 */
export function buildUninstallEntry(entry: UninstallEntry): RegArgs[] {
  const exe = join(entry.installDir, EXE_NAME);
  const commands: RegArgs[] = [
    addValue('DisplayName', 'REG_SZ', PRODUCT_NAME),
    addValue('DisplayVersion', 'REG_SZ', entry.version),
    addValue('Publisher', 'REG_SZ', PUBLISHER),
    addValue('DisplayIcon', 'REG_SZ', `${exe},0`),
    addValue('InstallLocation', 'REG_SZ', entry.installDir),
    addValue('UninstallString', 'REG_SZ', `"${exe}" ${UNINSTALL_ARG}`),
    addValue('NoModify', 'REG_DWORD', '1'),
    addValue('NoRepair', 'REG_DWORD', '1'),
  ];
  if (entry.estimatedSizeKb !== undefined && Number.isInteger(entry.estimatedSizeKb) && entry.estimatedSizeKb > 0) {
    commands.push(addValue('EstimatedSize', 'REG_DWORD', String(entry.estimatedSizeKb)));
  }
  return commands;
}

export function buildUninstallRemoval(): RegArgs {
  return ['delete', UNINSTALL_KEY, '/f'];
}

/** Runs `reg.exe` hidden and resolves with its exit code. It rejects only when `reg.exe` cannot start. */
export function runReg(args: RegArgs): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (error) => {
      if (error === null) {
        resolvePromise(0);
        return;
      }
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      if (typeof code === 'number') resolvePromise(code);
      else reject(error);
    });
  });
}

/**
 * The data of a value in `reg query KEY /v NAME` output (`    NAME    REG_SZ    data`), or null when the output has no such
 * value. The name is matched exactly (case-insensitively, as the registry does).
 */
export function parseRegQueryValue(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s{2,}(REG_[A-Z_]+)\s+(.*)$/.exec(line);
    if (match === null || match[1] === undefined || match[3] === undefined) continue;
    if (match[1].toLowerCase() === name.toLowerCase()) return match[3].trim();
  }
  return null;
}

/** Keys and value names reach `cmd.exe` as text, so only plain registry names are accepted. */
const PLAIN_REG_NAME = /^[A-Za-z0-9_.\\-]+$/;

/**
 * Reads one value with `reg query`. Resolves null when the key or the value does not exist; rejects when the registry
 * cannot be read at all ("not there" and "could not look" must not be the same answer to a caller that deletes).
 * `reg.exe` prints in the OEM code page, which garbles accents, so it runs after `chcp 65001` and prints UTF-8.
 * `key` and `name` are constants of this app; they are checked and then placed in the command line.
 */
export function readRegValue(key: string, name: string): Promise<string | null> {
  if (!PLAIN_REG_NAME.test(key) || !PLAIN_REG_NAME.test(name)) {
    return Promise.reject(new Error('nome de chave do registro não suportado'));
  }
  return new Promise((resolvePromise, reject) => {
    execFile(
      'cmd.exe',
      ['/d', '/c', `chcp 65001>nul & reg query ${key} /v ${name}`],
      { windowsHide: true, encoding: 'utf8', timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise(parseRegQueryValue(stdout, name));
          return;
        }
        const { code } = error as { code?: unknown };
        // `reg query` exits with 1 when the key or the value is missing.
        if (code === 1) resolvePromise(null);
        else reject(new Error(stderr.trim() === '' ? error.message : stderr.trim()));
      },
    );
  });
}

/** `InstallLocation` of the Nanachi uninstall entry, or null when there is no entry. */
export function readInstallLocation(): Promise<string | null> {
  return readRegValue(UNINSTALL_KEY, 'InstallLocation');
}

/** The Run command of "Iniciar com o Windows" (`"C:\...\Nanachi.exe" --hidden`), or null when it is off. */
export function readStartupCommand(): Promise<string | null> {
  return readRegValue(RUN_KEY, APP_USER_MODEL_ID);
}

/** The executable of a Run command: the quoted path, or the text up to `.exe` when it is not quoted. */
export function commandExecutable(command: string): string | null {
  const text = command.trim();
  if (text === '') return null;
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end > 1 ? text.slice(1, end) : null;
  }
  return /^.*?\.exe\b/i.exec(text)?.[0] ?? text.split(/\s+/)[0] ?? null;
}
