import { win32 } from 'node:path';

/**
 * Where Windows keeps its own programs. A bare `powershell.exe` is resolved from the child's working directory before
 * `PATH` (libuv searches the cwd first on Windows), so a child that runs from a writable folder such as `%TEMP%` would
 * start whatever `powershell.exe` is planted there. Callers use the absolute path and a working directory that normal
 * users cannot write to (`System32`).
 */

const FALLBACK_ROOT = 'C:\\Windows';

/** `SystemRoot` (`C:\Windows`), or `C:\Windows` when the variable is missing or is not an absolute drive path. */
export function windowsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value)) return FALLBACK_ROOT;
  return win32.normalize(value).replace(/\\+$/, '');
}

/** `C:\Windows\System32`: a folder only administrators can write to, used as the working directory of child processes. */
export function systemDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(windowsRoot(env), 'System32');
}

/** The absolute path of Windows PowerShell 5.1, which ships with every supported Windows. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemDirectory(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
