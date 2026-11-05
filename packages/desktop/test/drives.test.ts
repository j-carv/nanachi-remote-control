import { describe, expect, it, vi } from 'vitest';
import { powershellPath, systemDirectory } from '../src/common/system-paths.js';
import {
  createDriveLister,
  DRIVES_POWERSHELL_SCRIPT,
  driveKind,
  listDrives,
  parseDrivesJson,
  type DrivesDeps,
  type StatfsResult,
} from '../src/main/drives.js';
import type { ProcessResult } from '../src/main/system.js';

const GB = 1024 ** 3;

/** What `ConvertTo-Json` printed on a real PC with four fixed disks (4-space indentation, two spaces after the colon). */
const REAL_ARRAY = `[
    {
        "DeviceID":  "C:",
        "DriveType":  3,
        "VolumeName":  "",
        "Size":  999243640832,
        "FreeSpace":  25862291456
    },
    {
        "DeviceID":  "E:",
        "DriveType":  3,
        "VolumeName":  "Dados",
        "Size":  1000148561920,
        "FreeSpace":  163265249280
    }
]`;

describe('parseDrivesJson', () => {
  it('parses the array PowerShell prints for several disks', () => {
    expect(parseDrivesJson(REAL_ARRAY)).toEqual([
      { root: 'C:\\', label: null, kind: 'fixed', totalBytes: 999243640832, freeBytes: 25862291456 },
      { root: 'E:\\', label: 'Dados', kind: 'fixed', totalBytes: 1000148561920, freeBytes: 163265249280 },
    ]);
  });

  it('parses the single object PowerShell prints when there is one disk (no array around it)', () => {
    const json = '{"DeviceID":"C:","DriveType":3,"VolumeName":"Sistema","Size":500000000000,"FreeSpace":100000000000}';
    expect(parseDrivesJson(json)).toEqual([
      { root: 'C:\\', label: 'Sistema', kind: 'fixed', totalBytes: 500000000000, freeBytes: 100000000000 },
    ]);
  });

  it('tolerates nulls: a card reader or an optical drive without media has no size and no label', () => {
    const json = JSON.stringify([
      { DeviceID: 'D:', DriveType: 5, VolumeName: null, Size: null, FreeSpace: null },
      { DeviceID: 'F:', DriveType: 2, VolumeName: null, Size: null, FreeSpace: null },
    ]);
    expect(parseDrivesJson(json)).toEqual([
      { root: 'D:\\', label: null, kind: 'optical', totalBytes: null, freeBytes: null },
      { root: 'F:\\', label: null, kind: 'removable', totalBytes: null, freeBytes: null },
    ]);
  });

  it('reads sizes that come as numeric strings, and refuses nonsense sizes', () => {
    const json = JSON.stringify([
      { DeviceID: 'C:', DriveType: 3, VolumeName: 'A', Size: '1000', FreeSpace: '250' },
      { DeviceID: 'D:', DriveType: 3, VolumeName: 'B', Size: -5, FreeSpace: 'abc' },
      { DeviceID: 'E:', DriveType: 3, VolumeName: 'C', Size: 100, FreeSpace: 900 },
    ]);
    expect(parseDrivesJson(json)).toEqual([
      { root: 'C:\\', label: 'A', kind: 'fixed', totalBytes: 1000, freeBytes: 250 },
      { root: 'D:\\', label: 'B', kind: 'fixed', totalBytes: null, freeBytes: null },
      // Free space cannot exceed the total.
      { root: 'E:\\', label: 'C', kind: 'fixed', totalBytes: 100, freeBytes: 100 },
    ]);
  });

  it('maps DriveType: network, removable, optical, fixed, anything else unknown', () => {
    expect(driveKind(2)).toBe('removable');
    expect(driveKind(3)).toBe('fixed');
    expect(driveKind(4)).toBe('network');
    expect(driveKind(5)).toBe('optical');
    expect(driveKind(0)).toBe('unknown');
    expect(driveKind(6)).toBe('unknown');
    expect(driveKind(null)).toBe('unknown');
    expect(driveKind('4')).toBe('network');
  });

  it('skips entries without a usable drive letter and drives without a root directory (DriveType 1)', () => {
    const json = JSON.stringify([
      { DeviceID: 'C:', DriveType: 3, VolumeName: '', Size: 10, FreeSpace: 1 },
      { DeviceID: null, DriveType: 3 },
      { DeviceID: '\\\\servidor\\x', DriveType: 4 },
      { DeviceID: 'Z:', DriveType: 1, Size: null, FreeSpace: null },
      'texto',
      null,
      42,
    ]);
    expect(parseDrivesJson(json)?.map((drive) => drive.root)).toEqual(['C:\\']);
  });

  it('upper-cases the letter, drops duplicates and sorts by letter', () => {
    const json = JSON.stringify([
      { DeviceID: 'e:', DriveType: 3 },
      { DeviceID: 'C:', DriveType: 3 },
      { DeviceID: 'E:', DriveType: 3 },
    ]);
    expect(parseDrivesJson(json)?.map((drive) => drive.root)).toEqual(['C:\\', 'E:\\']);
  });

  it('trims the label and turns a blank one into null', () => {
    const json = JSON.stringify([
      { DeviceID: 'C:', DriveType: 3, VolumeName: '  Meu disco  ' },
      { DeviceID: 'D:', DriveType: 3, VolumeName: '   ' },
    ]);
    expect(parseDrivesJson(json)?.map((drive) => drive.label)).toEqual(['Meu disco', null]);
  });

  it('accepts a BOM, and gives an empty list for empty output and null for what is not JSON', () => {
    expect(parseDrivesJson(`\uFEFF${REAL_ARRAY}`)).toHaveLength(2);
    expect(parseDrivesJson('')).toEqual([]);
    expect(parseDrivesJson('   \r\n')).toEqual([]);
    expect(parseDrivesJson('null')).toEqual([]);
    expect(parseDrivesJson('Get-CimInstance : erro')).toBeNull();
    expect(parseDrivesJson('"texto"')).toEqual([]);
  });
});

function ok(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function deps(overrides: Partial<DrivesDeps> = {}): DrivesDeps & { run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(() => Promise.resolve(ok(REAL_ARRAY)));
  return {
    run,
    statfs: () => Promise.reject(new Error('sem fallback neste teste')),
    ...overrides,
  } as DrivesDeps & { run: ReturnType<typeof vi.fn> };
}

describe('listDrives', () => {
  it('runs one PowerShell with the documented flags and a 5 s timeout', async () => {
    const d = deps();
    const drives = await listDrives(d);
    expect(drives.map((drive) => drive.root)).toEqual(['C:\\', 'E:\\']);
    expect(d.run).toHaveBeenCalledTimes(1);
    const [command, args, options] = d.run.mock.calls[0] as [string, string[], { cwd: string; timeoutMs: number }];
    // The absolute path and a folder normal users cannot write to: a bare name would be looked up in the cwd first.
    expect(command).toBe(powershellPath());
    expect(command).toMatch(/^[A-Za-z]:\\.*\\powershell\.exe$/);
    expect(options.cwd).toBe(systemDirectory());
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toBe(DRIVES_POWERSHELL_SCRIPT);
    expect(DRIVES_POWERSHELL_SCRIPT).toContain('Get-CimInstance Win32_LogicalDisk');
    expect(DRIVES_POWERSHELL_SCRIPT).toContain('Select-Object DeviceID,DriveType,VolumeName,Size,FreeSpace');
    expect(DRIVES_POWERSHELL_SCRIPT).toContain('ConvertTo-Json');
    expect(options.timeoutMs).toBe(5_000);
  });

  it('asks PowerShell for UTF-8 so a label with accents survives the pipe', () => {
    expect(DRIVES_POWERSHELL_SCRIPT).toMatch(/OutputEncoding\s*=\s*New-Object System\.Text\.UTF8Encoding \$false/);
  });

  const statfs = (letterToResult: Record<string, StatfsResult>): DrivesDeps['statfs'] => (path) => {
    const result = letterToResult[path.slice(0, 1)];
    return result === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(result);
  };

  it.each([
    ['PowerShell timed out', () => Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: true })],
    ['PowerShell failed', () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'erro', timedOut: false })],
    ['PowerShell printed garbage', () => Promise.resolve(ok('not json at all'))],
    ['PowerShell printed nothing', () => Promise.resolve(ok(''))],
    ['PowerShell could not start', () => Promise.reject(new Error('spawn powershell.exe ENOENT'))],
  ])('falls back to probing the letters when %s', async (_label, run) => {
    const d = deps({
      run,
      statfs: statfs({ C: { bsize: 4096, blocks: 1000, bavail: 250 }, Z: { bsize: 512, blocks: 2000, bavail: 2000 } }),
    });
    const drives = await listDrives(d);
    expect(drives).toEqual([
      { root: 'C:\\', label: null, kind: 'unknown', totalBytes: 4096 * 1000, freeBytes: 4096 * 250 },
      { root: 'Z:\\', label: null, kind: 'unknown', totalBytes: 512 * 2000, freeBytes: 512 * 2000 },
    ]);
  });

  it('the fallback probes A: to Z:, gives up on a letter that hangs, and treats an empty volume as unknown size', async () => {
    const probed: string[] = [];
    const d = deps({
      run: () => Promise.resolve(ok('')),
      probeTimeoutMs: 20,
      statfs: (path) => {
        probed.push(path);
        if (path.startsWith('E')) return new Promise<StatfsResult>(() => undefined);
        if (path.startsWith('F')) return Promise.resolve({ bsize: 4096, blocks: 0, bavail: 0 });
        if (path.startsWith('C')) return Promise.resolve({ bsize: 4096, blocks: 100, bavail: 10 });
        return Promise.reject(new Error('ENOENT'));
      },
    });
    const drives = await listDrives(d);
    expect(probed).toEqual('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`));
    expect(drives.map((drive) => drive.root)).toEqual(['C:\\', 'F:\\']);
    expect(drives[1]).toMatchObject({ totalBytes: null, freeBytes: null });
  });

  it('returns an empty list when nothing can be found at all', async () => {
    const d = deps({ run: () => Promise.reject(new Error('x')) });
    expect(await listDrives(d)).toEqual([]);
  });

  it('shares one lookup between calls that overlap', async () => {
    let release: (result: ProcessResult) => void = () => undefined;
    const run = vi.fn(() => new Promise<ProcessResult>((resolve) => (release = resolve)));
    const lister = createDriveLister(deps({ run }), { cacheMs: 0 });
    const first = lister();
    const second = lister();
    release(ok(REAL_ARRAY));
    expect(await first).toEqual(await second);
    expect(run).toHaveBeenCalledTimes(1);
    // With no cache, a later call looks again.
    run.mockImplementation(() => Promise.resolve(ok(REAL_ARRAY)));
    await lister();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps the answer for a few seconds, so a window that gets the focus again does not start another PowerShell', async () => {
    let clock = 1_000;
    const run = vi.fn(() => Promise.resolve(ok(REAL_ARRAY)));
    const lister = createDriveLister(deps({ run }), { cacheMs: 5_000, now: () => clock });
    const first = await lister();
    clock += 4_999;
    expect(await lister()).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    // A cached answer is a copy: whoever gets it cannot change what the next caller sees.
    first.pop();
    expect(await lister()).toHaveLength(2);
    clock += 1;
    await lister();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reports sizes as plain numbers of bytes', async () => {
    const d = deps({ run: () => Promise.resolve(ok(JSON.stringify({ DeviceID: 'C:', DriveType: 3, VolumeName: '', Size: 2 * GB, FreeSpace: GB }))) });
    expect(await listDrives(d)).toEqual([{ root: 'C:\\', label: null, kind: 'fixed', totalBytes: 2 * GB, freeBytes: GB }]);
  });
});
