import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseInstallFlags } from '../src/install/args.js';
import { DATA_DIR_NAME, STANDALONE_DATA_DIR_NAME } from '../src/install/constants.js';
import { assertInsideInstall, checkDataFolder, checkInstallTarget, isInside, samePath } from '../src/install/guards.js';
import { buildPayloadMeta, parsePayloadMeta, readPayload } from '../src/install/payload.js';
import { parseProcessList, scanPrefix } from '../src/install/processes.js';
import { buildUninstallEntry, buildUninstallRemoval, commandExecutable, parseRegQueryValue, readRegValue } from '../src/install/registry.js';
import { assertSafeForCmd, buildRemovalScript, removalCommandArgs } from '../src/install/removal.js';
import { isOwnWindowCaller } from '../src/install/sender.js';
import { removeDir } from './remove-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-install-basics-'));
});
afterEach(() => {
  removeDir(dir);
});

describe('parseInstallFlags', () => {
  it('reads the test-mode flags and ignores everything else', () => {
    const flags = parseInstallFlags([
      '--target',
      'C:\\Temp\\Nanachi test',
      '--no-shortcuts',
      '--no-registry',
      '--no-launch',
      '--yes',
      '--delete-data',
      '--inspect=0',
      '--unknown',
    ]);
    expect(flags).toEqual({
      target: 'C:\\Temp\\Nanachi test',
      noShortcuts: true,
      noRegistry: true,
      noLaunch: true,
      yes: true,
      deleteData: true,
    });
  });

  it('defaults to a real install: nothing set', () => {
    expect(parseInstallFlags([])).toEqual({
      target: null,
      noShortcuts: false,
      noRegistry: false,
      noLaunch: false,
      yes: false,
      deleteData: false,
    });
  });

  it('accepts --target=<dir> and rejects --target without a folder', () => {
    expect(parseInstallFlags(['--target=D:\\Apps\\Nanachi']).target).toBe('D:\\Apps\\Nanachi');
    expect(() => parseInstallFlags(['--target'])).toThrow(/--target/);
    expect(() => parseInstallFlags(['--target', '--yes'])).toThrow(/--target/);
    expect(() => parseInstallFlags(['--target='])).toThrow(/--target/);
  });
});

describe('checkInstallTarget', () => {
  const context = { profile: 'C:\\Users\\ana', desktopHome: 'C:\\Users\\ana\\.nanachi-desktop', exists: () => false };

  it('accepts a folder under the profile and one on another drive', () => {
    expect(checkInstallTarget('C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi', context)).toEqual({
      ok: true,
      dir: resolve('C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi'),
    });
    expect(checkInstallTarget('D:\\Apps\\Nanachi', context).ok).toBe(true);
  });

  it('refuses a drive root', () => {
    for (const root of ['C:\\', 'C:', 'D:\\']) {
      const result = checkInstallTarget(root, context);
      expect(result.ok, root).toBe(false);
    }
  });

  it('refuses the user profile and anything above it', () => {
    for (const path of ['C:\\Users\\ana', 'C:\\Users\\ana\\', 'C:\\Users', 'c:\\users\\ANA']) {
      expect(checkInstallTarget(path, context).ok, path).toBe(false);
    }
  });

  it('refuses Desktop\'s data folder, anything inside it and anything that contains it', () => {
    expect(checkInstallTarget('C:\\Users\\ana\\.nanachi-desktop', context).ok).toBe(false);
    expect(checkInstallTarget('C:\\Users\\ana\\.nanachi-desktop\\app', context).ok).toBe(false);
    expect(checkInstallTarget('C:\\Users', context).ok).toBe(false);
    const custom = { ...context, desktopHome: 'D:\\Dados\\nanachi' };
    expect(checkInstallTarget('D:\\Dados', custom).ok).toBe(false);
    expect(checkInstallTarget('D:\\Dados\\nanachi\\x', custom).ok).toBe(false);
  });

  it('also refuses the standalone daemon\'s folder (.nanachi-remote) without being told about it', () => {
    expect(checkInstallTarget('C:\\Users\\ana\\.nanachi-remote', context).ok).toBe(false);
    expect(checkInstallTarget('C:\\Users\\ana\\.nanachi-remote\\app', context).ok).toBe(false);
  });

  it('also refuses the NANACHI_HOME of the environment, anything inside it and anything that holds it', () => {
    const withEnv = { ...context, standaloneDirs: ['D:\\Supervisor\\data'] };
    expect(checkInstallTarget('D:\\Supervisor\\data', withEnv).ok).toBe(false);
    expect(checkInstallTarget('D:\\Supervisor\\data\\app', withEnv).ok).toBe(false);
    expect(checkInstallTarget('D:\\Supervisor', withEnv).ok).toBe(false);
    expect(checkInstallTarget('D:\\Other', withEnv).ok).toBe(true);
    // A blank value is no folder at all.
    expect(checkInstallTarget('D:\\Other', { ...context, standaloneDirs: ['', '  '] }).ok).toBe(true);
  });

  it('refuses a path that has a .nanachi-desktop or .nanachi-remote segment, or a folder that holds one', () => {
    const elsewhere = { ...context, desktopHome: 'D:\\Dados\\home' };
    for (const name of [DATA_DIR_NAME, STANDALONE_DATA_DIR_NAME]) {
      expect(checkInstallTarget(`E:\\x\\${name}\\y`, elsewhere).ok, name).toBe(false);
      const holds = { ...elsewhere, exists: (path: string) => path === join('E:\\apps', name) };
      expect(checkInstallTarget('E:\\apps', holds).ok, name).toBe(false);
      expect(checkInstallTarget('E:\\other', holds).ok, name).toBe(true);
    }
  });

  it('refuses empty, relative and NUL-carrying paths', () => {
    for (const path of ['', '   ', 'relative\\folder', '.\\here', 'C:\\ok\0bad']) {
      expect(checkInstallTarget(path, context).ok, JSON.stringify(path)).toBe(false);
    }
  });

  it('notices a real data folder of either kind inside the target (default existence check)', () => {
    for (const name of [DATA_DIR_NAME, STANDALONE_DATA_DIR_NAME]) {
      const target = join(dir, `apps-${name}`);
      mkdirSync(join(target, name), { recursive: true });
      const result = checkInstallTarget(target, { profile: join(dir, 'profile'), desktopHome: join(dir, 'profile', DATA_DIR_NAME) });
      expect(result.ok, name).toBe(false);
    }
  });
});

describe('path helpers', () => {
  it('compares paths without case or trailing separators', () => {
    expect(samePath('C:\\Apps\\Nanachi\\', 'c:\\apps\\nanachi')).toBe(true);
    expect(samePath('C:\\Apps\\Nanachi', 'C:\\Apps\\Nanachi2')).toBe(false);
  });

  it('isInside is strict: not itself, not a sibling with the same prefix, not a parent', () => {
    expect(isInside('C:\\Apps\\Nanachi', 'C:\\Apps\\Nanachi\\resources')).toBe(true);
    expect(isInside('C:\\Apps\\Nanachi', 'C:\\Apps\\Nanachi')).toBe(false);
    expect(isInside('C:\\Apps\\Nanachi', 'C:\\Apps\\Nanachi-old\\x')).toBe(false);
    expect(isInside('C:\\Apps\\Nanachi', 'C:\\Apps')).toBe(false);
    expect(isInside('C:\\Apps\\Nanachi', 'C:\\Apps\\Nanachi\\..\\Other')).toBe(false);
  });

  it('assertInsideInstall throws for anything outside the install folder', () => {
    const install = 'C:\\Apps\\Nanachi';
    expect(() => assertInsideInstall(install, `${install}\\resources\\app.asar`)).not.toThrow();
    expect(() => assertInsideInstall(install, install)).toThrow(/recusado/);
    expect(() => assertInsideInstall(install, 'C:\\Apps\\Nanachi\\..\\..\\Windows')).toThrow(/recusado/);
    expect(() => assertInsideInstall(install, 'C:\\Users\\ana\\.nanachi-remote')).toThrow(/recusado/);
  });
});

describe('payload', () => {
  it('reads payload.json and refuses a broken one', () => {
    const meta = buildPayloadMeta({ version: '1.0.0', files: 3, uncompressedBytes: 1234 });
    expect(parsePayloadMeta(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
    expect(() => parsePayloadMeta(null)).toThrow();
    expect(() => parsePayloadMeta({ ...meta, schema: 2 })).toThrow(/formato/);
    expect(() => parsePayloadMeta({ ...meta, exe: '..\\evil.exe' })).toThrow(/exe/);
    expect(() => parsePayloadMeta({ ...meta, files: 0 })).toThrow(/files/);
    expect(() => parsePayloadMeta({ ...meta, uncompressedBytes: 'x' })).toThrow(/uncompressedBytes/);
  });

  it('readPayload names the missing file', () => {
    expect(() => readPayload(dir)).toThrow(/payload\.zip/);
    writeFileSync(join(dir, 'payload.zip'), 'x');
    writeFileSync(join(dir, 'payload.json'), JSON.stringify(buildPayloadMeta({ version: '2.0.0', files: 1, uncompressedBytes: 1 })));
    expect(readPayload(dir).meta.version).toBe('2.0.0');
  });
});

describe('uninstall registry entry', () => {
  it('writes every value the contract names under the per-user Uninstall key', () => {
    const commands = buildUninstallEntry({ installDir: 'C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi', version: '1.4.0', estimatedSizeKb: 900 });
    const values = new Map(commands.map((args) => [args[3], { type: args[5], data: args[7] }]));
    for (const args of commands) {
      expect(args[0]).toBe('add');
      expect(args[1]).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nanachi');
      expect(args[2]).toBe('/v');
      expect(args[4]).toBe('/t');
      expect(args[6]).toBe('/d');
      expect(args[8]).toBe('/f');
    }
    const exe = 'C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi\\Nanachi.exe';
    expect(values.get('DisplayName')).toEqual({ type: 'REG_SZ', data: 'Nanachi' });
    expect(values.get('DisplayVersion')).toEqual({ type: 'REG_SZ', data: '1.4.0' });
    expect(values.get('Publisher')).toEqual({ type: 'REG_SZ', data: 'Nanachi' });
    expect(values.get('DisplayIcon')).toEqual({ type: 'REG_SZ', data: `${exe},0` });
    expect(values.get('InstallLocation')).toEqual({ type: 'REG_SZ', data: 'C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi' });
    expect(values.get('UninstallString')).toEqual({ type: 'REG_SZ', data: `"${exe}" --uninstall` });
    expect(values.get('NoModify')).toEqual({ type: 'REG_DWORD', data: '1' });
    expect(values.get('NoRepair')).toEqual({ type: 'REG_DWORD', data: '1' });
    expect(values.get('EstimatedSize')).toEqual({ type: 'REG_DWORD', data: '900' });
  });

  it('omits the size when it is unknown, and removes the key with /f', () => {
    const names = buildUninstallEntry({ installDir: 'C:\\x', version: '1' }).map((args) => args[3]);
    expect(names).not.toContain('EstimatedSize');
    expect(buildUninstallRemoval()).toEqual(['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nanachi', '/f']);
  });
});

describe('process scan and scheduled removal', () => {
  it('parses `pid<TAB>name` lines and skips noise', () => {
    expect(parseProcessList('101\tNanachi.exe\r\n202\tnode.exe\n\nnot a line\nx\tnode.exe\n0\tidle.exe\n')).toEqual([
      { pid: 101, name: 'Nanachi.exe' },
      { pid: 202, name: 'node.exe' },
    ]);
  });

  it('scans with a trailing separator so a sibling folder does not match', () => {
    expect(scanPrefix('C:\\Apps\\Nanachi')).toBe('C:\\Apps\\Nanachi\\');
    expect(scanPrefix('C:\\Apps\\Nanachi\\')).toBe('C:\\Apps\\Nanachi\\');
  });

  it('builds a retrying rmdir loop per folder and quotes paths with spaces', () => {
    const script = buildRemovalScript(['C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi', 'C:\\Temp\\two words']);
    expect(script).toContain('for /l %i in (1,1,30) do if exist "C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi" (rmdir /s /q "C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi"');
    expect(script).toContain('rmdir /s /q "C:\\Temp\\two words"');
    expect(script.split(' & for /l').length).toBe(2);
  });

  it('refuses a path cmd.exe would expand or break out of', () => {
    for (const path of ['C:\\100%\\x', 'C:\\a"b', 'C:\\a\nb']) {
      expect(() => assertSafeForCmd(path), JSON.stringify(path)).toThrow(/não suportado/);
      expect(() => buildRemovalScript([path])).toThrow();
    }
    expect(() => assertSafeForCmd('C:\\Área de Trabalho\\Nanachi & co')).not.toThrow();
  });
});

describe('reg.exe arguments', () => {
  it('reach the program unchanged through the Windows command line, quotes and accents included', async () => {
    const installDir = 'C:\\Users\\Ana Lúcia\\AppData\\Local\\Programs\\Nanachi';
    const entry = buildUninstallEntry({ installDir, version: '1.0.0', estimatedSizeKb: 5 });
    const echo = 'console.log(JSON.stringify(process.argv.slice(1)))';
    for (const args of entry) {
      const { stdout } = await promisify(execFile)(process.execPath, ['-e', echo, ...args], { windowsHide: true });
      expect(JSON.parse(stdout) as string[]).toEqual(args);
    }
    const uninstallString = entry.find((args) => args[3] === 'UninstallString');
    expect(uninstallString?.[7]).toBe(`"${installDir}\\Nanachi.exe" --uninstall`);
  });
});

describe('checkDataFolder', () => {
  const context = {
    profile: 'C:\\Users\\ana',
    installDir: 'C:\\Users\\ana\\AppData\\Local\\Programs\\Nanachi',
    requireAll: ['config.json', 'data.db'],
  };
  const has = (...present: string[]) => (path: string) => present.some((name) => path.endsWith(name));

  it('accepts a complete path that holds config.json and data.db', () => {
    const check = checkDataFolder('C:\\Users\\ana\\.nanachi-desktop', { ...context, exists: has('config.json', 'data.db') });
    expect(check).toEqual({ ok: true, dir: 'C:\\Users\\ana\\.nanachi-desktop' });
  });

  describe('the standalone daemon\'s folder is never deleted', () => {
    const exists = (): boolean => true;

    it('refuses %USERPROFILE%\\.nanachi-remote, anything inside it, even with config.json and data.db', () => {
      for (const input of ['C:\\Users\\ana\\.nanachi-remote', 'c:\\users\\ANA\\.nanachi-remote\\', 'C:\\Users\\ana\\.nanachi-remote\\accounts']) {
        const check = checkDataFolder(input, { ...context, exists });
        expect(check.ok, input).toBe(false);
        if (!check.ok) expect(check.reason).toMatch(/\.nanachi-remote|daemon avulso/);
      }
    });

    it('refuses the NANACHI_HOME value of the environment, a folder inside it and one that holds it', () => {
      const env = { ...context, standaloneDirs: ['D:\\Supervisor\\data'], exists };
      for (const input of ['D:\\Supervisor\\data', 'D:\\Supervisor\\data\\sub', 'D:\\Supervisor']) {
        expect(checkDataFolder(input, env).ok, input).toBe(false);
      }
      expect(checkDataFolder('D:\\Desktop\\data', env).ok).toBe(true);
    });

    it('applies to the Desktop profile check too (any folder that goes through the guard)', () => {
      const profileCheck = { profile: 'C:\\Users\\ana', installDir: 'D:\\Nanachi', requireAny: ['machine.bin'], standaloneDirs: ['D:\\Supervisor\\data'], exists };
      expect(checkDataFolder('D:\\Supervisor\\data', profileCheck).ok).toBe(false);
      expect(checkDataFolder('C:\\Users\\ana\\.nanachi-remote', profileCheck).ok).toBe(false);
      expect(checkDataFolder('C:\\Users\\ana\\AppData\\Roaming\\Nanachi', profileCheck).ok).toBe(true);
    });

    it('a blank NANACHI_HOME entry does not block anything', () => {
      expect(checkDataFolder('C:\\Users\\ana\\.nanachi-desktop', { ...context, standaloneDirs: ['', '  '], exists }).ok).toBe(true);
    });
  });

  it.each([
    ['an empty path', ''],
    ['a blank path', '   '],
    ['a relative path', 'nanachi-data'],
    ['a path relative to the current drive', '\\nanachi-data'],
    ['a drive-relative path', 'C:nanachi-data'],
    ['a path with a NUL', 'C:\\data\0x'],
  ])('refuses %s without looking at the disk', (_label, input) => {
    const check = checkDataFolder(input, { ...context, exists: () => true });
    expect(check.ok).toBe(false);
  });

  it('refuses a drive root, the profile, a folder above the profile and the install folder', () => {
    const exists = (): boolean => true;
    for (const input of ['C:\\', 'C:\\Users\\ana', 'C:\\Users', context.installDir, 'C:\\Users\\ana\\AppData\\Local\\Programs']) {
      expect(checkDataFolder(input, { ...context, exists }).ok, input).toBe(false);
    }
  });

  it('refuses a folder that overlaps one of the "others"', () => {
    const exists = (): boolean => true;
    const check = checkDataFolder('C:\\Users\\ana\\AppData\\Roaming\\Nanachi', {
      ...context,
      others: ['C:\\Users\\ana\\AppData\\Roaming\\Nanachi\\sub'],
      exists,
    });
    expect(check.ok).toBe(false);
  });

  it('needs every name of requireAll and at least one of requireAny', () => {
    expect(checkDataFolder('C:\\Users\\ana\\data', { ...context, exists: has('config.json') }).ok).toBe(false);
    expect(checkDataFolder('C:\\Users\\ana\\data', { ...context, exists: has('data.db') }).ok).toBe(false);
    expect(checkDataFolder('C:\\Users\\ana\\profile', { profile: 'C:\\Users\\ana', installDir: 'D:\\Nanachi', requireAny: ['machine.bin', 'desktop-settings.json'], exists: has('desktop-settings.json') }).ok).toBe(true);
    expect(checkDataFolder('C:\\Users\\ana\\profile', { profile: 'C:\\Users\\ana', installDir: 'D:\\Nanachi', requireAny: ['machine.bin', 'desktop-settings.json'], exists: () => false }).ok).toBe(false);
  });

  it('accepts a UNC path', () => {
    const check = checkDataFolder('\\\\server\\share\\nanachi', {
      profile: 'C:\\Users\\ana',
      installDir: 'D:\\Nanachi',
      requireAll: ['data.db'],
      exists: () => true,
    });
    expect(check.ok).toBe(true);
  });
});

describe('reading the registry', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nanachi',
    '    DisplayName    REG_SZ    Nanachi',
    '    InstallLocation    REG_SZ    C:\\Users\\José\\AppData\\Local\\Programs\\Nanachi Área',
    '    UninstallString    REG_SZ    "C:\\Users\\José\\AppData\\Local\\Programs\\Nanachi\\Nanachi.exe" --uninstall',
    '',
  ].join('\r\n');

  it('parseRegQueryValue returns the data of the named value, accents and spaces included', () => {
    expect(parseRegQueryValue(output, 'InstallLocation')).toBe('C:\\Users\\José\\AppData\\Local\\Programs\\Nanachi Área');
    expect(parseRegQueryValue(output, 'installlocation')).toBe('C:\\Users\\José\\AppData\\Local\\Programs\\Nanachi Área');
    expect(parseRegQueryValue(output, 'UninstallString')).toBe('"C:\\Users\\José\\AppData\\Local\\Programs\\Nanachi\\Nanachi.exe" --uninstall');
  });

  it('parseRegQueryValue is null for a value that is not there, an empty value and output with no values', () => {
    expect(parseRegQueryValue(output, 'Publisher')).toBeNull();
    expect(parseRegQueryValue('    InstallLocation    REG_SZ    \r\n', 'InstallLocation')).toBe('');
    expect(parseRegQueryValue('ERROR: The system was unable to find the specified registry key or value.', 'InstallLocation')).toBeNull();
    expect(parseRegQueryValue('', 'InstallLocation')).toBeNull();
  });

  it('readRegValue refuses names that would reach cmd.exe as syntax', async () => {
    await expect(readRegValue('HKCU\\Software\\X & calc', 'InstallLocation')).rejects.toThrow(/não suportado/);
    await expect(readRegValue('HKCU\\Software\\X', 'a"b')).rejects.toThrow(/não suportado/);
  });

  // Read-only queries of the real registry (nothing is written).
  it.skipIf(process.platform !== 'win32')('readRegValue reads a value that exists and is null for a key or value that does not', async () => {
    expect(await readRegValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', 'OEMCP')).toMatch(/^\d+$/);
    expect(await readRegValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', 'NanachiNoSuchValue')).toBeNull();
    expect(await readRegValue('HKCU\\Software\\NanachiNoSuchKey', 'InstallLocation')).toBeNull();
  });

  it('commandExecutable reads the exe of a Run command, quoted or not', () => {
    expect(commandExecutable('"C:\\Program Files\\Nanachi\\Nanachi.exe" --hidden')).toBe('C:\\Program Files\\Nanachi\\Nanachi.exe');
    expect(commandExecutable('C:\\Nanachi\\Nanachi.exe --hidden')).toBe('C:\\Nanachi\\Nanachi.exe');
    expect(commandExecutable('   ')).toBeNull();
    expect(commandExecutable('"unterminated')).toBeNull();
  });
});

describe('scheduled removal command line', () => {
  it('runs cmd with delayed expansion off, no AutoRun and the quoted script', () => {
    const args = removalCommandArgs(['C:\\Temp\\Nanachi']);
    expect(args.slice(0, 4)).toEqual(['/v:off', '/d', '/s', '/c']);
    expect(args[4]).toBe(`"${buildRemovalScript(['C:\\Temp\\Nanachi'])}"`);
  });

  it('refuses a path with ! (delayed expansion), % or a quote', () => {
    for (const path of ['C:\\Users\\Jo!\\Nanachi', 'C:\\Users\\%USERNAME%\\Nanachi', 'C:\\Users\\x"y']) {
      expect(() => removalCommandArgs([path]), path).toThrow(/não suportado/);
    }
  });
});

describe('isOwnWindowCaller', () => {
  const frame = (url: string, parent: unknown = null) => ({ url, parent });

  it('trusts the main frame of this process\'s own window showing a local file', () => {
    expect(isOwnWindowCaller({ sender: { id: 7 }, senderFrame: frame('file:///C:/app/installer.html') }, 7)).toBe(true);
  });

  it('refuses another web contents, a missing window, a missing frame, a subframe and a remote page', () => {
    expect(isOwnWindowCaller({ sender: { id: 8 }, senderFrame: frame('file:///C:/app/installer.html') }, 7)).toBe(false);
    expect(isOwnWindowCaller({ sender: { id: 7 }, senderFrame: frame('file:///C:/app/installer.html') }, null)).toBe(false);
    expect(isOwnWindowCaller({ sender: { id: 7 } }, 7)).toBe(false);
    expect(isOwnWindowCaller({ sender: { id: 7 }, senderFrame: null }, 7)).toBe(false);
    expect(isOwnWindowCaller({ sender: { id: 7 }, senderFrame: frame('file:///C:/app/installer.html', { url: 'file:///x' }) }, 7)).toBe(false);
    expect(isOwnWindowCaller({ sender: { id: 7 }, senderFrame: frame('https://evil.example/') }, 7)).toBe(false);
    expect(isOwnWindowCaller({ sender: { id: 7 }, senderFrame: frame('http://127.0.0.1:7777/') }, 7)).toBe(false);
  });
});
