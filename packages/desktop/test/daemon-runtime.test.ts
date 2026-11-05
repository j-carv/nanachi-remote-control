import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  missingRuntimeFile,
  readConfiguredPort,
  resolveHome,
  resolveRuntime,
} from '../src/main/daemon-runtime.js';
import { removeDir } from './remove-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-desktop-runtime-'));
});
afterEach(() => {
  removeDir(dir);
});

describe('resolveRuntime', () => {
  it('packaged: node.exe and the daemon both come from resources/runtime', () => {
    const runtime = resolveRuntime({
      packaged: true,
      resourcesPath: join(dir, 'resources'),
      repoRoot: join(dir, 'repo'),
    });
    const root = join(dir, 'resources', 'runtime');
    expect(runtime.nodePath).toBe(join(root, 'node.exe'));
    expect(runtime.daemonMain).toBe(join(root, 'packages', 'daemon', 'dist', 'main.js'));
    expect(runtime.daemonCli).toBe(join(root, 'packages', 'daemon', 'dist', 'cli.js'));
    expect(runtime.cwd).toBe(root);
  });

  it('dev: node from PATH runs the daemon build of the repo', () => {
    const runtime = resolveRuntime({ packaged: false, resourcesPath: join(dir, 'ignored'), repoRoot: join(dir, 'repo') });
    expect(runtime.nodePath).toBe('node');
    expect(runtime.daemonMain).toBe(join(dir, 'repo', 'packages', 'daemon', 'dist', 'main.js'));
    expect(runtime.daemonCli).toBe(join(dir, 'repo', 'packages', 'daemon', 'dist', 'cli.js'));
    expect(runtime.cwd).toBe(join(dir, 'repo'));
  });

  it('missingRuntimeFile names the first file that is not on disk', () => {
    const runtime = resolveRuntime({ packaged: true, resourcesPath: dir, repoRoot: dir });
    expect(missingRuntimeFile(runtime)).toBe(runtime.nodePath);

    mkdirSync(join(dir, 'runtime', 'packages', 'daemon', 'dist'), { recursive: true });
    writeFileSync(runtime.nodePath, '');
    expect(missingRuntimeFile(runtime)).toBe(runtime.daemonMain);

    writeFileSync(runtime.daemonMain, '');
    expect(missingRuntimeFile(runtime)).toBe(runtime.daemonCli);

    writeFileSync(runtime.daemonCli, '');
    expect(missingRuntimeFile(runtime)).toBeNull();
  });

  it('missingRuntimeFile does not look for "node" on disk in dev mode', () => {
    const runtime = resolveRuntime({ packaged: false, resourcesPath: dir, repoRoot: dir });
    mkdirSync(join(dir, 'packages', 'daemon', 'dist'), { recursive: true });
    writeFileSync(runtime.daemonMain, '');
    writeFileSync(runtime.daemonCli, '');
    expect(missingRuntimeFile(runtime)).toBeNull();
  });
});

describe('resolveHome', () => {
  it('uses NANACHI_HOME, else the same default folder as the daemon CLI', () => {
    expect(resolveHome({ NANACHI_HOME: 'D:\\dados' }, 'C:\\Users\\user')).toBe('D:\\dados');
    expect(resolveHome({}, 'C:\\Users\\user')).toBe(join('C:\\Users\\user', '.nanachi-remote'));
  });
});

describe('readConfiguredPort', () => {
  it('defaults to 7777 when config.json does not exist', () => {
    expect(readConfiguredPort(dir)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(7777);
  });

  it('reads the port, tolerating a UTF-8 BOM written by PowerShell 5.1', () => {
    writeFileSync(join(dir, 'config.json'), '\uFEFF{ "port": 7811, "allowedRoots": [] }');
    expect(readConfiguredPort(dir)).toBe(7811);
  });

  it('falls back to the default for unreadable or out-of-range values', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ not json');
    expect(readConfiguredPort(dir)).toBe(7777);
    writeFileSync(file, '{ "port": 70000 }');
    expect(readConfiguredPort(dir)).toBe(7777);
    writeFileSync(file, '{ "port": "7811" }');
    expect(readConfiguredPort(dir)).toBe(7777);
    writeFileSync(file, '{}');
    expect(readConfiguredPort(dir)).toBe(7777);
  });
});
