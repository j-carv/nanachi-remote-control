import { execFile, spawn } from 'node:child_process';
import { sep } from 'node:path';
import { t } from '../common/i18n/index.js';
import { powershellPath, systemDirectory } from '../common/system-paths.js';

/** A process whose executable lives inside a folder (the install folder). */
export interface RunningProcess {
  pid: number;
  name: string;
}

/**
 * Every process whose executable path starts with the folder, except `selfPid` and its direct children (Chromium's
 * helper processes), so the uninstaller does not kill itself. The folder and the pid go through environment variables:
 * a path with spaces or accents never touches the PowerShell command line.
 */
const SCAN_SCRIPT = [
  '$dir = $env:NANACHI_SCAN_DIR; $self = [int]$env:NANACHI_SELF_PID;',
  'Get-CimInstance Win32_Process |',
  'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) -and $_.ProcessId -ne $self -and $_.ParentProcessId -ne $self } |',
  // One `pid<TAB>name` line per process; no quotes or backticks, so the command line needs no escaping.
  "ForEach-Object { '{0}{1}{2}' -f $_.ProcessId, [char]9, $_.Name }",
].join(' ');

export function parseProcessList(output: string): RunningProcess[] {
  const found: RunningProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [pid, name] = line.split('\t');
    const parsed = Number(pid);
    if (pid !== undefined && Number.isInteger(parsed) && parsed > 0 && name !== undefined && name.trim() !== '') {
      found.push({ pid: parsed, name: name.trim() });
    }
  }
  return found;
}

/** The folder with a trailing separator, so `C:\Apps\Nanachi` does not match `C:\Apps\Nanachi-old\x.exe`. */
export function scanPrefix(dir: string): string {
  return dir.endsWith(sep) ? dir : `${dir}${sep}`;
}

/** The part of `execFile` the scan uses; tests pass a fake. */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd?: string; windowsHide: boolean; timeout: number; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

/**
 * Rejects when the scan itself fails: "nothing runs" must never be an answer made up from an error. PowerShell is the
 * absolute system one, run from `System32`: a bare `powershell.exe` is looked up in the working directory first.
 */
export function findRunningInDir(dir: string, selfPid: number, exec: ExecFileLike = execFile): Promise<RunningProcess[]> {
  return new Promise((resolvePromise, reject) => {
    exec(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCAN_SCRIPT],
      {
        cwd: systemDirectory(),
        windowsHide: true,
        timeout: 30_000,
        env: { ...process.env, NANACHI_SCAN_DIR: scanPrefix(dir), NANACHI_SELF_PID: String(selfPid) },
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim().split(/\r?\n/)[0];
          reject(new Error(t('installer.errors.listProcesses', { detail: detail === undefined || detail === '' ? error.message : detail })));
          return;
        }
        resolvePromise(parseProcessList(stdout));
      },
    );
  });
}

/** `taskkill /T /F` on each pid (the process and what it started). Never rejects: a process already gone is fine. */
export async function stopProcessTrees(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    await new Promise<void>((resolvePromise) => {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => resolvePromise());
      killer.once('close', () => resolvePromise());
    });
  }
}
