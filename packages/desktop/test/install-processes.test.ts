import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { powershellPath, systemDirectory } from '../src/common/system-paths.js';
import { findRunningInDir, type ExecFileLike } from '../src/install/processes.js';

describe('findRunningInDir (command line)', () => {
  it('runs the absolute system PowerShell from System32, never a bare name looked up in the working directory', async () => {
    const seen: Array<{ file: string; cwd: string | undefined }> = [];
    const exec: ExecFileLike = (file, _args, options, callback) => {
      seen.push({ file, cwd: options.cwd });
      callback(null, '', '');
      return undefined;
    };
    await expect(findRunningInDir('C:\Apps\Nanachi', 1, exec)).resolves.toEqual([]);
    expect(seen).toEqual([{ file: powershellPath(), cwd: systemDirectory() }]);
  });
});

/**
 * The real scan, against the real process list: the one thing the fake `findRunning` of the other tests cannot prove.
 * The test process itself is the process to find (its Node executable lives in a folder, and it is running).
 */
describe.runIf(process.platform === 'win32')('findRunningInDir (PowerShell, real processes)', () => {
  const folder = dirname(process.execPath);

  it('finds a process by the folder its executable lives in', async () => {
    const found = await findRunningInDir(folder, 1);
    expect(found.some((entry) => entry.pid === process.pid)).toBe(true);
    expect(found.find((entry) => entry.pid === process.pid)?.name.toLowerCase()).toBe('node.exe');
  }, 30_000);

  it('does not report the pid it was told is its own', async () => {
    const found = await findRunningInDir(folder, process.pid);
    expect(found.some((entry) => entry.pid === process.pid)).toBe(false);
  }, 30_000);

  it('matches a folder, not a name prefix: a sibling with the same start does not match', async () => {
    const found = await findRunningInDir(`${folder}-does-not-exist`, 1);
    expect(found).toEqual([]);
  }, 30_000);
});
