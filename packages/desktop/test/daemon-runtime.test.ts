import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT,
  ensureDesktopConfig,
  missingRuntimeFile,
  readConfiguredPort,
  resolveHome,
  resolveRuntime,
  standaloneHomes,
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

describe('resolveHome (Desktop\'s own data folder)', () => {
  it('uses NANACHI_DESKTOP_HOME when it is set', () => {
    expect(resolveHome({ NANACHI_DESKTOP_HOME: 'D:\\dados do desktop' }, 'C:\\Users\\user')).toBe('D:\\dados do desktop');
  });

  it('defaults to .nanachi-desktop in the user profile, never the standalone daemon\'s folder', () => {
    const home = resolveHome({}, 'C:\\Users\\user');
    expect(home).toBe(join('C:\\Users\\user', '.nanachi-desktop'));
    expect(home).not.toContain('.nanachi-remote');
  });

  it('never reads NANACHI_HOME, with or without an override', () => {
    expect(resolveHome({ NANACHI_HOME: 'D:\\supervisor' }, 'C:\\Users\\user')).toBe(join('C:\\Users\\user', '.nanachi-desktop'));
    expect(resolveHome({ NANACHI_HOME: 'D:\\supervisor', NANACHI_DESKTOP_HOME: 'E:\\desktop' }, 'C:\\Users\\user')).toBe('E:\\desktop');
  });

  it('treats an empty NANACHI_DESKTOP_HOME as not set', () => {
    expect(resolveHome({ NANACHI_DESKTOP_HOME: '' }, 'C:\\Users\\user')).toBe(join('C:\\Users\\user', '.nanachi-desktop'));
  });
});

describe('standaloneHomes', () => {
  it('is the NANACHI_HOME of the environment when it is set', () => {
    expect(standaloneHomes({ NANACHI_HOME: 'D:\\supervisor' })).toEqual(['D:\\supervisor']);
  });

  it('is empty when NANACHI_HOME is missing or blank, and ignores NANACHI_DESKTOP_HOME', () => {
    expect(standaloneHomes({})).toEqual([]);
    expect(standaloneHomes({ NANACHI_HOME: '' })).toEqual([]);
    expect(standaloneHomes({ NANACHI_HOME: '   ' })).toEqual([]);
    expect(standaloneHomes({ NANACHI_DESKTOP_HOME: 'E:\\desktop' })).toEqual([]);
  });
});

describe('readConfiguredPort', () => {
  it('defaults to 7780 (Desktop\'s own port, not the supervisor\'s 7777) when config.json does not exist', () => {
    expect(readConfiguredPort(dir)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(7780);
  });

  it('reads the port, tolerating a UTF-8 BOM written by PowerShell 5.1', () => {
    writeFileSync(join(dir, 'config.json'), '\uFEFF{ "port": 7811, "allowedRoots": [] }');
    expect(readConfiguredPort(dir)).toBe(7811);
  });

  it('an existing config.json wins, even with 7777 (the user pointed Desktop at it on purpose)', () => {
    writeFileSync(join(dir, 'config.json'), '{ "port": 7777 }');
    expect(readConfiguredPort(dir)).toBe(7777);
  });

  it('falls back to the default for unreadable or out-of-range values', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ not json');
    expect(readConfiguredPort(dir)).toBe(7780);
    writeFileSync(file, '{ "port": 70000 }');
    expect(readConfiguredPort(dir)).toBe(7780);
    writeFileSync(file, '{ "port": "7811" }');
    expect(readConfiguredPort(dir)).toBe(7780);
    writeFileSync(file, '{}');
    expect(readConfiguredPort(dir)).toBe(7780);
  });
});

describe('ensureDesktopConfig', () => {
  it('creates the folder and writes { "port": 7780 } when config.json is missing', () => {
    const home = join(dir, 'fresh', '.nanachi-desktop');
    expect(ensureDesktopConfig(home)).toBe('created');
    const bytes = readFileSync(join(home, 'config.json'));
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ port: 7780 });
    // UTF-8 without a BOM, and a trailing newline.
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(bytes.toString('utf8').endsWith('\n')).toBe(true);
    expect(readConfiguredPort(home)).toBe(7780);
  });

  it('writes into an existing empty folder as well, and a path with spaces and accents', () => {
    const home = join(dir, 'Área de Trabalho', 'dados do desktop');
    mkdirSync(home, { recursive: true });
    expect(ensureDesktopConfig(home)).toBe('created');
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toEqual({ port: 7780 });
  });

  it('leaves an existing valid config.json byte for byte as it was (BOM, other keys and all)', () => {
    const file = join(dir, 'config.json');
    const mine = Buffer.from('\uFEFF{ "port": 7811, "allowedTailscaleLogins": ["me@example.com"] }\r\n', 'utf8');
    writeFileSync(file, mine);
    expect(ensureDesktopConfig(dir)).toBe('kept');
    expect(readFileSync(file).equals(mine)).toBe(true);
  });

  it.each([
    ['not JSON', '{ not json'],
    ['an empty file', ''],
    ['a bad port', '{ "port": 70000 }'],
    ['no port', '{}'],
  ])('leaves an invalid config.json alone (%s); the daemon reports the problem', (_label, content) => {
    const file = join(dir, 'config.json');
    writeFileSync(file, content);
    expect(ensureDesktopConfig(dir)).toBe('kept');
    expect(readFileSync(file, 'utf8')).toBe(content);
  });

  it('is idempotent: a second call keeps what the first one wrote', () => {
    expect(ensureDesktopConfig(dir)).toBe('created');
    const first = readFileSync(join(dir, 'config.json'));
    expect(ensureDesktopConfig(dir)).toBe('kept');
    expect(readFileSync(join(dir, 'config.json')).equals(first)).toBe(true);
  });

  it('reports a folder it cannot create', () => {
    // A file where the folder should be.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    expect(() => ensureDesktopConfig(join(blocker, 'home'))).toThrow();
  });
});
