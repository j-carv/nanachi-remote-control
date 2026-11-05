import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_MARKER } from '../src/install/constants.js';
import { type FsLike, InstallError, runInstall } from '../src/install/install.js';
import type { RunningProcess } from '../src/install/processes.js';
import { removeTree } from '../src/install/safe-remove.js';
import { planUninstall, runUninstall, type UninstallDeps, type UninstallOptions, type UninstallProgress } from '../src/install/uninstall.js';
import { makeInstallDeps, makeJunction, makePayload, makeSandbox, type Sandbox } from './install-support.js';

let sandbox: Sandbox;
let desktopData: string;
beforeEach(async () => {
  sandbox = makeSandbox();
  desktopData = join(sandbox.profile, 'AppData', 'Roaming', 'Nanachi');
  // A real install in the sandbox (extraction runs for real), then data folders next to it.
  const payload = await makePayload(join(sandbox.root, 'payload'));
  const { deps } = makeInstallDeps(sandbox, payload);
  await runInstall(
    { target: sandbox.target, desktopShortcut: true, startWithWindows: true, noShortcuts: true, noRegistry: true },
    deps,
  );
  mkdirSync(sandbox.nanachiHome, { recursive: true });
  writeFileSync(join(sandbox.nanachiHome, 'config.json'), '{"port":7777}');
  writeFileSync(join(sandbox.nanachiHome, 'data.db'), 'sqlite');
  mkdirSync(desktopData, { recursive: true });
  writeFileSync(join(desktopData, 'machine.bin'), 'token');
});
afterEach(() => {
  sandbox.cleanup();
});

function options(overrides: Partial<UninstallOptions> = {}): UninstallOptions {
  return { installDir: sandbox.target, deleteData: false, noShortcuts: false, noRegistry: false, ...overrides };
}

interface UninstallRecorder {
  events: UninstallProgress[];
  stopped: number[][];
  reg: string[][];
  removeStartup: number;
  scheduled: string[][];
  shortcutReads: string[];
}

function makeDeps(overrides: Partial<UninstallDeps> = {}): { deps: UninstallDeps; recorder: UninstallRecorder } {
  const recorder: UninstallRecorder = { events: [], stopped: [], reg: [], removeStartup: 0, scheduled: [], shortcutReads: [] };
  const deps: UninstallDeps = {
    profile: sandbox.profile,
    nanachiHome: sandbox.nanachiHome,
    desktopDataDir: desktopData,
    startMenuDir: sandbox.startMenuDir,
    desktopDir: sandbox.desktopDir,
    selfPid: 1,
    findRunning: () => Promise.resolve([]),
    stopProcesses: (pids) => {
      recorder.stopped.push(pids);
      return Promise.resolve();
    },
    readShortcutTarget: (path) => {
      recorder.shortcutReads.push(path);
      return join(sandbox.target, 'Nanachi.exe');
    },
    readStartupCommand: () => Promise.resolve(`"${join(sandbox.target, 'Nanachi.exe')}" --hidden`),
    removeStartup: () => {
      recorder.removeStartup += 1;
    },
    readInstallLocation: () => Promise.resolve(sandbox.target),
    runReg: (args) => {
      recorder.reg.push(args);
      return Promise.resolve(0);
    },
    homeInUse: () => Promise.resolve(false),
    scheduleRemoval: (dirs) => void recorder.scheduled.push(dirs),
    emit: (progress) => void recorder.events.push(progress),
    sleep: () => Promise.resolve(),
    removeOptions: { sleep: () => undefined },
    ...overrides,
  };
  return { deps, recorder };
}

function makeShortcuts(): string[] {
  const start = join(sandbox.startMenuDir, 'Nanachi.lnk');
  const desk = join(sandbox.desktopDir, 'Nanachi.lnk');
  for (const path of [start, desk]) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'lnk');
  }
  return [start, desk];
}

describe('planUninstall', () => {
  it('has the contract steps and skips data unless asked', () => {
    const plan = planUninstall(options());
    expect(plan.map((step) => step.id)).toEqual(['stop', 'shortcuts', 'startup', 'files', 'data', 'registry']);
    expect(plan.find((step) => step.id === 'data')?.skipped).toMatch(/dados ficam/);
    expect(planUninstall(options({ deleteData: true })).find((step) => step.id === 'data')?.skipped).toBeNull();
    expect(plan.reduce((sum, step) => sum + step.weight, 0)).toBe(100);
  });
});

describe('runUninstall', () => {
  it('removes the install folder and keeps the data', async () => {
    const { deps, recorder } = makeDeps();
    const result = await runUninstall(options({ noShortcuts: true, noRegistry: true }), deps);

    expect(result).toEqual({ removalScheduled: false, warnings: [] });
    expect(existsSync(sandbox.target)).toBe(false);
    expect(readFileSync(join(sandbox.nanachiHome, 'config.json'), 'utf8')).toBe('{"port":7777}');
    expect(existsSync(join(sandbox.nanachiHome, 'data.db'))).toBe(true);
    expect(existsSync(join(desktopData, 'machine.bin'))).toBe(true);
    expect(recorder.scheduled).toEqual([]);
    expect(recorder.events.at(-1)).toMatchObject({ step: 'registry', state: 'skipped', percent: 100 });
  });

  it('in test mode does not touch shortcuts, the login item or the registry', async () => {
    const shortcuts = makeShortcuts();
    const { deps, recorder } = makeDeps();
    await runUninstall(options({ noShortcuts: true, noRegistry: true }), deps);

    for (const path of shortcuts) expect(existsSync(path), path).toBe(true);
    expect(recorder.shortcutReads).toEqual([]);
    expect(recorder.removeStartup).toBe(0);
    expect(recorder.reg).toEqual([]);
  });

  it('a normal run removes the shortcuts that point at this install, the login item and the uninstall key', async () => {
    const shortcuts = makeShortcuts();
    const { deps, recorder } = makeDeps();
    await runUninstall(options(), deps);

    for (const path of shortcuts) expect(existsSync(path), path).toBe(false);
    expect(recorder.removeStartup).toBe(1);
    expect(recorder.reg).toEqual([['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nanachi', '/f']]);
  });

  it('leaves a same-named shortcut that points somewhere else', async () => {
    const [start, desk] = makeShortcuts();
    const { deps } = makeDeps({
      readShortcutTarget: (path) => (path === start ? join(sandbox.root, 'other', 'Nanachi.exe') : join(sandbox.target, 'Nanachi.exe')),
    });
    await runUninstall(options(), deps);
    expect(existsSync(start as string)).toBe(true);
    expect(existsSync(desk as string)).toBe(false);
  });

  it('tolerates a missing uninstall key (reg exits with 1) but warns about other failures', async () => {
    const missing = makeDeps({ runReg: () => Promise.resolve(1) });
    await expect(runUninstall(options(), missing.deps)).resolves.toMatchObject({ warnings: [] });

    // A second install to uninstall again.
    const payload = await makePayload(join(sandbox.root, 'payload-b'));
    const reinstall = makeInstallDeps(sandbox, payload);
    await runInstall({ target: sandbox.target, desktopShortcut: false, startWithWindows: false, noShortcuts: true, noRegistry: true }, reinstall.deps);
    const broken = makeDeps({ runReg: () => Promise.resolve(5) });
    const result = await runUninstall(options(), broken.deps);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/lista de aplicativos/);
  });

  it('stops what runs from the folder, except itself', async () => {
    let running: RunningProcess[] = [
      { pid: 1, name: 'Nanachi.exe' },
      { pid: 50, name: 'Nanachi.exe' },
      { pid: 51, name: 'node.exe' },
    ];
    const { deps, recorder } = makeDeps({
      selfPid: 1,
      findRunning: () => Promise.resolve(running),
      stopProcesses: (pids) => {
        recorder.stopped.push(pids);
        running = [{ pid: 1, name: 'Nanachi.exe' }];
        return Promise.resolve();
      },
    });
    await runUninstall(options({ noShortcuts: true, noRegistry: true }), deps);
    expect(recorder.stopped).toEqual([[50, 51]]);
    expect(existsSync(sandbox.target)).toBe(false);
  });

  it('warns, and goes on, when a process will not close', async () => {
    const { deps } = makeDeps({ findRunning: () => Promise.resolve([{ pid: 70, name: 'node.exe' }]) });
    const result = await runUninstall(options({ noShortcuts: true, noRegistry: true }), deps);
    expect(result.warnings.join(' ')).toMatch(/não fecharam/);
  });

  it('schedules a detached cleanup when something is still held, and removes everything else now', async () => {
    const locked = join(sandbox.target, 'Nanachi.exe');
    const fs: FsLike = {
      ...nodeFs,
      // What a running exe looks like to the delete: its file cannot be unlinked.
      unlinkSync: (path) => {
        if (String(path) === locked) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        nodeFs.unlinkSync(path);
      },
    };
    const { deps, recorder } = makeDeps({ fs });
    const result = await runUninstall(options({ noShortcuts: true, noRegistry: true }), deps);

    expect(result.removalScheduled).toBe(true);
    expect(recorder.scheduled).toEqual([[sandbox.target]]);
    // Only the held exe is left, with the marker (removed last, so the folder still reads as a Nanachi install).
    expect(readdirSync(sandbox.target).sort()).toEqual([INSTALL_MARKER, 'Nanachi.exe']);
  });

  it('does not follow a junction out of the install folder', async () => {
    const outside = join(sandbox.root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'precious.txt'), 'do not delete');
    symlinkSync(outside, join(sandbox.target, 'link-to-outside'), 'junction');

    const { deps } = makeDeps();
    await runUninstall(options({ noShortcuts: true, noRegistry: true }), deps);
    expect(existsSync(sandbox.target)).toBe(false);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('do not delete');
  });

  describe('data', () => {
    it('is deleted only when asked: the data folder and the Desktop profile', async () => {
      const { deps } = makeDeps();
      const result = await runUninstall(options({ deleteData: true, noShortcuts: true, noRegistry: true }), deps);
      expect(result.warnings).toEqual([]);
      expect(existsSync(sandbox.nanachiHome)).toBe(false);
      expect(existsSync(desktopData)).toBe(false);
      expect(existsSync(sandbox.target)).toBe(false);
      expect(existsSync(sandbox.profile)).toBe(true);
    });

    it('is kept, with a warning, while a daemon uses the data folder', async () => {
      const { deps } = makeDeps({ homeInUse: () => Promise.resolve(true) });
      const result = await runUninstall(options({ deleteData: true, noShortcuts: true, noRegistry: true }), deps);
      expect(result.warnings.join(' ')).toMatch(/daemon/);
      expect(existsSync(join(sandbox.nanachiHome, 'config.json'))).toBe(true);
      expect(existsSync(join(desktopData, 'machine.bin'))).toBe(true);
      expect(existsSync(sandbox.target)).toBe(false);
    });

    it('never deletes a folder that does not look like Nanachi data, or the user profile', async () => {
      const notData = join(sandbox.root, 'some-other-folder');
      mkdirSync(notData, { recursive: true });
      writeFileSync(join(notData, 'important.txt'), 'x');
      const unrelated = makeDeps({ nanachiHome: notData, desktopDataDir: notData });
      const result = await runUninstall(options({ deleteData: true, noShortcuts: true, noRegistry: true }), unrelated.deps);
      expect(existsSync(join(notData, 'important.txt'))).toBe(true);
      expect(result.warnings.join(' ')).toMatch(/não foram apagados/);
      // Rebuild the install for the next case.
      const payload = await makePayload(join(sandbox.root, 'payload-c'));
      const redo = makeInstallDeps(sandbox, payload);
      await runInstall({ target: sandbox.target, desktopShortcut: false, startWithWindows: false, noShortcuts: true, noRegistry: true }, redo.deps);

      writeFileSync(join(sandbox.profile, 'config.json'), '{}');
      const profileAsHome = makeDeps({ nanachiHome: sandbox.profile, desktopDataDir: sandbox.profile });
      await runUninstall(options({ deleteData: true, noShortcuts: true, noRegistry: true }), profileAsHome.deps);
      expect(existsSync(join(sandbox.profile, 'config.json'))).toBe(true);
      expect(existsSync(sandbox.profile)).toBe(true);
    });
  });

  describe('path guards', () => {
    it('refuses a folder that is not a Nanachi install (no marker) and removes nothing', async () => {
      const stranger = join(sandbox.root, 'stranger');
      mkdirSync(stranger, { recursive: true });
      writeFileSync(join(stranger, 'Nanachi.exe'), 'not ours');
      const { deps, recorder } = makeDeps();
      await expect(runUninstall(options({ installDir: stranger }), deps)).rejects.toBeInstanceOf(InstallError);
      expect(existsSync(join(stranger, 'Nanachi.exe'))).toBe(true);
      expect(recorder.events).toEqual([]);
      expect(recorder.reg).toEqual([]);
    });

    it('refuses a folder that does not exist', async () => {
      const { deps } = makeDeps();
      await expect(runUninstall(options({ installDir: join(sandbox.root, 'ghost') }), deps)).rejects.toThrow(/não parece uma instalação/);
    });

    const unsafe: Array<[string, () => string]> = [
      ['a drive root', () => 'C:\\'],
      ['the user profile', () => sandbox.profile],
      ['the folder that holds the profile', () => sandbox.root],
      ['the data folder', () => sandbox.nanachiHome],
    ];
    for (const [name, installDir] of unsafe) {
      it(`refuses ${name}, even with a marker inside`, async () => {
        const target = installDir();
        if (target !== 'C:\\') writeFileSync(join(target, INSTALL_MARKER), '{"version":"1","installedAt":"x","complete":true}');
        const { deps, recorder } = makeDeps();
        await expect(runUninstall(options({ installDir: target }), deps)).rejects.toBeInstanceOf(InstallError);
        expect(existsSync(sandbox.profile)).toBe(true);
        expect(existsSync(join(sandbox.nanachiHome, 'data.db'))).toBe(true);
        expect(recorder.events).toEqual([]);
        if (target !== 'C:\\') nodeFs.rmSync(join(target, INSTALL_MARKER), { force: true });
      });
    }
  });

  it('reports every step in order', async () => {
    const { deps, recorder } = makeDeps({ homeInUse: vi.fn(() => Promise.resolve(false)) });
    await runUninstall(options({ deleteData: true }), deps);
    const order = recorder.events.filter((event) => event.state === 'done').map((event) => event.step);
    expect(order).toEqual(['stop', 'shortcuts', 'startup', 'files', 'data', 'registry']);
    expect(recorder.events.at(-1)?.percent).toBe(100);
  });
});

/** The install the previous run in the same test removed, back again. */
let reinstallCount = 0;
async function reinstall(): Promise<void> {
  reinstallCount += 1;
  const payload = await makePayload(join(sandbox.root, `payload-again-${reinstallCount}`));
  await runInstall(
    { target: sandbox.target, desktopShortcut: false, startWithWindows: false, noShortcuts: true, noRegistry: true },
    makeInstallDeps(sandbox, payload).deps,
  );
}

describe('runUninstall: data with junctions (the agents\' own folders)', () => {
  /** `accounts\claude\acc-1\{projects,skills}` -> `~/.claude`, `accounts\codex\acc-2\sessions` -> `~/.codex`. */
  function linkAgentFolders(): { claudeProjects: string; codexSessions: string } {
    const claudeProjects = join(sandbox.profile, '.claude', 'projects');
    const claudeSkills = join(sandbox.profile, '.claude', 'skills');
    const codexSessions = join(sandbox.profile, '.codex', 'sessions');
    for (const dir of [claudeProjects, claudeSkills, codexSessions]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(claudeProjects, 'session.jsonl'), 'claude history');
    writeFileSync(join(claudeSkills, 'SKILL.md'), 'skill');
    writeFileSync(join(codexSessions, 'rollout.jsonl'), 'codex history');
    makeJunction(claudeProjects, join(sandbox.nanachiHome, 'accounts', 'claude', 'acc-1', 'projects'));
    makeJunction(claudeSkills, join(sandbox.nanachiHome, 'accounts', 'claude', 'acc-1', 'skills'));
    makeJunction(codexSessions, join(sandbox.nanachiHome, 'accounts', 'codex', 'acc-2', 'sessions'));
    // And one at the top of the data folder.
    makeJunction(join(sandbox.profile, '.claude'), join(sandbox.nanachiHome, 'claude-link'));
    return { claudeProjects, codexSessions };
  }

  it('deletes the data folder but never what its junctions point to', async () => {
    const { claudeProjects, codexSessions } = linkAgentFolders();
    const { deps } = makeDeps();
    const result = await runUninstall(options({ deleteData: true, noShortcuts: true, noRegistry: true }), deps);

    expect(result.warnings).toEqual([]);
    expect(existsSync(sandbox.nanachiHome)).toBe(false);
    expect(readFileSync(join(claudeProjects, 'session.jsonl'), 'utf8')).toBe('claude history');
    expect(readFileSync(join(sandbox.profile, '.claude', 'skills', 'SKILL.md'), 'utf8')).toBe('skill');
    expect(readFileSync(join(codexSessions, 'rollout.jsonl'), 'utf8')).toBe('codex history');
  });

  it('keeps the data (and the targets) when "Apagar também os dados" is not ticked', async () => {
    const { claudeProjects } = linkAgentFolders();
    const { deps } = makeDeps();
    await runUninstall(options({ noShortcuts: true, noRegistry: true }), deps);
    expect(existsSync(join(sandbox.nanachiHome, 'config.json'))).toBe(true);
    expect(existsSync(join(sandbox.nanachiHome, 'accounts', 'claude', 'acc-1', 'projects'))).toBe(true);
    expect(existsSync(join(claudeProjects, 'session.jsonl'))).toBe(true);
  });

  it('says so when the data folder itself is a junction: only the link goes', async () => {
    const real = join(sandbox.root, 'moved-data');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'config.json'), '{}');
    writeFileSync(join(real, 'data.db'), 'sqlite');
    removeTree(sandbox.nanachiHome, nodeFs);
    makeJunction(real, sandbox.nanachiHome);

    const { deps } = makeDeps();
    const result = await runUninstall(options({ deleteData: true, noShortcuts: true, noRegistry: true }), deps);
    expect(existsSync(join(real, 'data.db'))).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/atalho \(junção\)/);
  });
});

describe('runUninstall: the data-deletion guard', () => {
  /** Runs a "delete the data" uninstall whose NANACHI_HOME is `home`; the warnings it gave. */
  async function warningsFor(home: string): Promise<string[]> {
    const { deps } = makeDeps({ nanachiHome: home, desktopDataDir: join(sandbox.root, 'nothing-here') });
    const result = await runUninstall(options({ deleteData: true, noShortcuts: true, noRegistry: true }), deps);
    return result.warnings;
  }

  function folderWith(dir: string, names: string[]): string {
    mkdirSync(dir, { recursive: true });
    for (const name of names) writeFileSync(join(dir, name), 'x');
    return dir;
  }

  it('needs config.json', async () => {
    const dir = folderWith(join(sandbox.root, 'only-db'), ['data.db']);
    expect((await warningsFor(dir)).join(' ')).toMatch(/não foram apagados.*config\.json/);
    expect(existsSync(join(dir, 'data.db'))).toBe(true);
  });

  it('needs data.db', async () => {
    const dir = folderWith(join(sandbox.root, 'only-config'), ['config.json']);
    expect((await warningsFor(dir)).join(' ')).toMatch(/não foram apagados.*data\.db/);
    expect(existsSync(join(dir, 'config.json'))).toBe(true);
  });

  it('never resolves a relative NANACHI_HOME against the working directory', async () => {
    // A folder that would match if the relative name were resolved from the cwd.
    const name = 'relative-nanachi-data-test';
    const cwdFolder = folderWith(join(process.cwd(), name), ['config.json', 'data.db']);
    try {
      expect((await warningsFor(name)).join(' ')).toMatch(/não é completo/);
      expect(existsSync(join(cwdFolder, 'data.db'))).toBe(true);
    } finally {
      removeTree(cwdFolder, nodeFs);
    }
  });

  it('treats an empty NANACHI_HOME as no data folder at all', async () => {
    expect(await warningsFor('')).toEqual([]);
    expect(existsSync(sandbox.profile)).toBe(true);
  });

  it('refuses the user profile even when it has config.json and data.db', async () => {
    const dir = folderWith(sandbox.profile, ['config.json', 'data.db']);
    expect((await warningsFor(dir)).join(' ')).toMatch(/não foram apagados/);
    expect(existsSync(join(dir, 'data.db'))).toBe(true);
  });

  // A data folder that holds the install folder stops the whole uninstall before anything is touched.
  it.each([
    ['a drive root', () => 'C:\\'],
    ['a folder that holds the profile and the install folder', () => sandbox.root],
    ['the install folder', () => sandbox.target],
  ])('refuses %s as the data folder before touching anything', async (_label, home) => {
    const dir = home();
    if (dir !== 'C:\\') folderWith(dir, ['config.json', 'data.db']);
    const { deps, recorder } = makeDeps({ nanachiHome: dir });
    await expect(runUninstall(options({ deleteData: true, noShortcuts: true, noRegistry: true }), deps)).rejects.toBeInstanceOf(InstallError);
    expect(recorder.events).toEqual([]);
    expect(existsSync(join(sandbox.target, 'Nanachi.exe'))).toBe(true);
    expect(existsSync(sandbox.profile)).toBe(true);
  });
});

describe('runUninstall: registry and login item belong to this install', () => {
  it('deletes the uninstall key when InstallLocation is this folder (case and a trailing slash do not matter)', async () => {
    const variants = [sandbox.target, sandbox.target.toUpperCase(), `${sandbox.target}\\`];
    for (const [index, location] of variants.entries()) {
      if (index > 0) await reinstall();
      const { deps, recorder } = makeDeps({ readInstallLocation: () => Promise.resolve(location) });
      const result = await runUninstall(options({ noShortcuts: true }), deps);
      expect(recorder.reg, location).toEqual([['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nanachi', '/f']]);
      expect(result.warnings, location).toEqual([]);
    }
  });

  it('keeps the key, with a warning, when it describes another install', async () => {
    const other = join(sandbox.root, 'Another Nanachi');
    const { deps, recorder } = makeDeps({ readInstallLocation: () => Promise.resolve(other) });
    const result = await runUninstall(options({ noShortcuts: true }), deps);
    expect(recorder.reg).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/outra instalação/);
    // The files of THIS install are still removed.
    expect(existsSync(sandbox.target)).toBe(false);
  });

  it('keeps the key when InstallLocation is empty', async () => {
    const { deps, recorder } = makeDeps({ readInstallLocation: () => Promise.resolve('') });
    await runUninstall(options({ noShortcuts: true }), deps);
    expect(recorder.reg).toEqual([]);
  });

  it('keeps the key, with a warning, when the registry cannot be read', async () => {
    const { deps, recorder } = makeDeps({ readInstallLocation: () => Promise.reject(new Error('acesso negado')) });
    const result = await runUninstall(options({ noShortcuts: true }), deps);
    expect(recorder.reg).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/acesso negado/);
  });

  it('does nothing about a key that is not there', async () => {
    const { deps, recorder } = makeDeps({ readInstallLocation: () => Promise.resolve(null) });
    const result = await runUninstall(options({ noShortcuts: true }), deps);
    expect(recorder.reg).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('removes the login item when its command starts THIS install\'s exe', async () => {
    const { deps, recorder } = makeDeps();
    await runUninstall(options({ noShortcuts: true }), deps);
    expect(recorder.removeStartup).toBe(1);
  });

  it('leaves the login item of another install alone', async () => {
    const { deps, recorder } = makeDeps({
      readStartupCommand: () => Promise.resolve(`"${join(sandbox.root, 'Another Nanachi', 'Nanachi.exe')}" --hidden`),
    });
    await runUninstall(options({ noShortcuts: true }), deps);
    expect(recorder.removeStartup).toBe(0);
  });

  it('leaves the login item alone when it is off', async () => {
    const { deps, recorder } = makeDeps({ readStartupCommand: () => Promise.resolve(null) });
    await runUninstall(options({ noShortcuts: true }), deps);
    expect(recorder.removeStartup).toBe(0);
  });

  it('leaves the login item alone, with a warning, when the registry cannot be read', async () => {
    const { deps, recorder } = makeDeps({ readStartupCommand: () => Promise.reject(new Error('sem acesso')) });
    const result = await runUninstall(options({ noShortcuts: true }), deps);
    expect(recorder.removeStartup).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/sem acesso/);
  });
});
