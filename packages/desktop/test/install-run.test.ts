import * as nodeFs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_MARKER } from '../src/install/constants.js';
import { type FsLike, InstallError, planInstall, readInstallMarker, runInstall, type InstallOptions } from '../src/install/install.js';
import type { Payload } from '../src/install/payload.js';
import { makeInstallDeps, makeJunction, makePayload, makeSandbox, SAMPLE_FILES, type Sandbox, writeSlipZip } from './install-support.js';

let sandbox: Sandbox;
let payload: Payload;
beforeEach(async () => {
  sandbox = makeSandbox();
  payload = await makePayload(join(sandbox.root, 'payload'));
});
afterEach(() => {
  sandbox.cleanup();
});

function options(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    target: sandbox.target,
    desktopShortcut: true,
    startWithWindows: true,
    noShortcuts: false,
    noRegistry: false,
    ...overrides,
  };
}

describe('planInstall', () => {
  it('lists the steps of the contract in order', () => {
    const plan = planInstall(options());
    expect(plan.map((step) => step.id)).toEqual(['close', 'extract', 'shortcuts', 'startup', 'registry']);
    expect(plan.every((step) => step.skipped === null)).toBe(true);
    expect(plan.reduce((sum, step) => sum + step.weight, 0)).toBe(100);
  });

  it('skips shortcuts, login item and registry in test mode, and the login item when it is switched off', () => {
    const byId = (opts: InstallOptions) => Object.fromEntries(planInstall(opts).map((step) => [step.id, step.skipped]));
    expect(byId(options({ noShortcuts: true })).shortcuts).toBe('modo de teste');
    expect(byId(options({ noRegistry: true }))).toMatchObject({ startup: 'modo de teste', registry: 'modo de teste', shortcuts: null });
    expect(byId(options({ startWithWindows: false })).startup).toBe('desligado nas opções');
  });
});

describe('runInstall', () => {
  it('extracts the payload into the target and marks the install complete', async () => {
    const { deps, recorder } = makeInstallDeps(sandbox, payload);
    const result = await runInstall(options({ noShortcuts: true, noRegistry: true }), deps);

    expect(result).toEqual({ installDir: sandbox.target, exe: join(sandbox.target, 'Nanachi.exe'), version: '1.2.3' });
    for (const [name, content] of Object.entries(SAMPLE_FILES)) {
      expect(readFileSync(join(sandbox.target, ...name.split('/')), 'utf8'), name).toBe(content);
    }
    expect(readInstallMarker(sandbox.target)).toMatchObject({ version: '1.2.3', complete: true });

    const last = recorder.events.at(-1);
    expect(last).toMatchObject({ step: 'registry', state: 'skipped', percent: 100 });
    // The bar only moves forward and the extraction reports on the way.
    const percents = recorder.events.map((event) => event.percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(recorder.events.some((event) => event.step === 'extract' && event.state === 'done')).toBe(true);
  });

  it('in test mode touches nothing outside the target: no shortcuts, no login item, no registry', async () => {
    const { deps, recorder } = makeInstallDeps(sandbox, payload);
    await runInstall(options({ noShortcuts: true, noRegistry: true }), deps);

    expect(recorder.shortcuts).toEqual([]);
    expect(recorder.startup).toEqual([]);
    expect(recorder.reg).toEqual([]);
    expect(existsSync(sandbox.startMenuDir)).toBe(false);
    expect(existsSync(sandbox.desktopDir)).toBe(false);
    expect(readdirSync(sandbox.profile)).toEqual([]);
    const skipped = recorder.events.filter((event) => event.state === 'skipped').map((event) => event.step);
    expect(skipped).toEqual(['shortcuts', 'startup', 'registry']);
  });

  it('a normal install creates both shortcuts, the login item and the uninstall entry', async () => {
    const { deps, recorder } = makeInstallDeps(sandbox, payload);
    await runInstall(options(), deps);
    const exe = join(sandbox.target, 'Nanachi.exe');

    expect(recorder.shortcuts.map((shortcut) => shortcut.path)).toEqual([
      join(sandbox.startMenuDir, 'Nanachi.lnk'),
      join(sandbox.desktopDir, 'Nanachi.lnk'),
    ]);
    for (const shortcut of recorder.shortcuts) {
      expect(shortcut).toMatchObject({ target: exe, cwd: sandbox.target, icon: exe, iconIndex: 0, appUserModelId: 'org.nanachi.desktop' });
    }
    expect(recorder.startup).toEqual([{ enabled: true, exe }]);
    const names = recorder.reg.map((args) => args[3]);
    expect(names).toEqual(expect.arrayContaining(['DisplayName', 'DisplayVersion', 'Publisher', 'DisplayIcon', 'InstallLocation', 'UninstallString', 'NoModify', 'NoRepair']));
    expect(recorder.reg.find((args) => args[3] === 'UninstallString')?.[7]).toBe(`"${exe}" --uninstall`);
    expect(recorder.reg.find((args) => args[3] === 'DisplayVersion')?.[7]).toBe('1.2.3');
  });

  it('honours the options: no desktop shortcut, no login item', async () => {
    const { deps, recorder } = makeInstallDeps(sandbox, payload);
    await runInstall(options({ desktopShortcut: false, startWithWindows: false }), deps);
    expect(recorder.shortcuts.map((shortcut) => shortcut.path)).toEqual([join(sandbox.startMenuDir, 'Nanachi.lnk')]);
    expect(recorder.startup).toEqual([]);
    expect(recorder.events.find((event) => event.step === 'startup')).toMatchObject({ state: 'skipped' });
    expect(recorder.reg.length).toBeGreaterThan(0);
  });

  it('fails when a shortcut cannot be written or reg.exe fails, with a message for the user', async () => {
    const noShortcut = makeInstallDeps(sandbox, payload, { writeShortcut: () => false });
    await expect(runInstall(options(), noShortcut.deps)).rejects.toThrow(/atalho/);

    const badReg = makeInstallDeps(sandbox, payload, { runReg: () => Promise.resolve(1) });
    await expect(runInstall(options(), badReg.deps)).rejects.toThrow(/reg\.exe/);
  });

  it('refuses a folder that is not empty and not a Nanachi install, and leaves it as it was', async () => {
    mkdirSync(sandbox.target, { recursive: true });
    writeFileSync(join(sandbox.target, 'minhas-coisas.txt'), 'keep me');
    const { deps, recorder } = makeInstallDeps(sandbox, payload);

    await expect(runInstall(options({ noShortcuts: true, noRegistry: true }), deps)).rejects.toThrow(/não está vazia/);
    expect(readdirSync(sandbox.target)).toEqual(['minhas-coisas.txt']);
    expect(readFileSync(join(sandbox.target, 'minhas-coisas.txt'), 'utf8')).toBe('keep me');
    expect(recorder.shortcuts).toEqual([]);
  });

  it('accepts an empty existing folder', async () => {
    mkdirSync(sandbox.target, { recursive: true });
    const { deps } = makeInstallDeps(sandbox, payload);
    await runInstall(options({ noShortcuts: true, noRegistry: true }), deps);
    expect(existsSync(join(sandbox.target, 'Nanachi.exe'))).toBe(true);
  });

  it('installs over an earlier install and clears what the new version no longer ships', async () => {
    const { deps } = makeInstallDeps(sandbox, payload);
    await runInstall(options({ noShortcuts: true, noRegistry: true }), deps);
    writeFileSync(join(sandbox.target, 'resources', 'old-file-from-1.0.txt'), 'stale');

    const next = await makePayload(join(sandbox.root, 'payload-2'), { 'Nanachi.exe': 'MZ v2', 'resources/app.asar': 'v2' }, '2.0.0');
    const second = makeInstallDeps(sandbox, next);
    await runInstall(options({ noShortcuts: true, noRegistry: true }), second.deps);

    expect(existsSync(join(sandbox.target, 'resources', 'old-file-from-1.0.txt'))).toBe(false);
    expect(existsSync(join(sandbox.target, 'resources', 'runtime'))).toBe(false);
    expect(readFileSync(join(sandbox.target, 'Nanachi.exe'), 'utf8')).toBe('MZ v2');
    expect(readInstallMarker(sandbox.target)).toMatchObject({ version: '2.0.0', complete: true });
  });

  it('a failed extraction leaves an incomplete marker, and running again over it works', async () => {
    const failing = makeInstallDeps(sandbox, payload, { extract: () => Promise.reject(new Error('disco cheio')) });
    await expect(runInstall(options({ noShortcuts: true, noRegistry: true }), failing.deps)).rejects.toThrow(/disco cheio/);
    expect(readInstallMarker(sandbox.target)).toMatchObject({ complete: false });

    const retry = makeInstallDeps(sandbox, payload);
    await runInstall(options({ noShortcuts: true, noRegistry: true }), retry.deps);
    expect(readInstallMarker(sandbox.target)).toMatchObject({ complete: true });
  });

  describe('upgrade over an earlier install', () => {
    async function installV1(): Promise<void> {
      const { deps } = makeInstallDeps(sandbox, payload);
      await runInstall(options({ noShortcuts: true, noRegistry: true }), deps);
    }

    it('never deletes the marker: it is rewritten as incomplete before anything goes, so a failed upgrade is still a Nanachi install', async () => {
      await installV1();
      const deleted: string[] = [];
      // Every delete the upgrade makes, with the marker checked at that moment.
      const watching: FsLike = {
        ...nodeFs,
        unlinkSync: (path) => {
          deleted.push(String(path));
          nodeFs.unlinkSync(path);
        },
      };
      const next = await makePayload(join(sandbox.root, 'payload-2'), { 'Nanachi.exe': 'MZ v2' }, '2.0.0');
      const failing = makeInstallDeps(sandbox, next, { fs: watching, extract: () => Promise.reject(new Error('disco cheio')) });
      await expect(runInstall(options({ noShortcuts: true, noRegistry: true }), failing.deps)).rejects.toThrow(/disco cheio/);

      expect(deleted.length).toBeGreaterThan(0);
      expect(deleted.some((path) => path.endsWith(INSTALL_MARKER))).toBe(false);
      // The old version's files are gone, the marker is there and says the install is not complete.
      expect(existsSync(join(sandbox.target, 'resources'))).toBe(false);
      expect(readInstallMarker(sandbox.target)).toMatchObject({ version: '2.0.0', complete: false });
    });

    it('leaves a marker even when clearing the old files fails halfway', async () => {
      await installV1();
      const held = join(sandbox.target, 'Nanachi.exe');
      const busy: FsLike = {
        ...nodeFs,
        unlinkSync: (path) => {
          if (String(path) === held) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          nodeFs.unlinkSync(path);
        },
      };
      const next = await makePayload(join(sandbox.root, 'payload-2'), { 'Nanachi.exe': 'MZ v2' }, '2.0.0');
      const { deps } = makeInstallDeps(sandbox, next, { fs: busy });
      await expect(runInstall(options({ noShortcuts: true, noRegistry: true }), deps)).rejects.toThrow(/Não foi possível substituir Nanachi\.exe/);
      expect(readInstallMarker(sandbox.target)).toMatchObject({ complete: false });
      // And running it again, with the exe free, works.
      const retry = makeInstallDeps(sandbox, next);
      await runInstall(options({ noShortcuts: true, noRegistry: true }), retry.deps);
      expect(readInstallMarker(sandbox.target)).toMatchObject({ version: '2.0.0', complete: true });
    });

    it('does not follow a junction inside the old install', async () => {
      await installV1();
      const outside = join(sandbox.root, 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'precious.txt'), 'do not delete');
      makeJunction(outside, join(sandbox.target, 'resources', 'link-to-outside'));
      makeJunction(outside, join(sandbox.target, 'top-level-link'));

      const next = await makePayload(join(sandbox.root, 'payload-2'), { 'Nanachi.exe': 'MZ v2' }, '2.0.0');
      const { deps } = makeInstallDeps(sandbox, next);
      await runInstall(options({ noShortcuts: true, noRegistry: true }), deps);
      expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('do not delete');
      expect(existsSync(join(sandbox.target, 'top-level-link'))).toBe(false);
    });
  });

  it('fails when the payload does not carry Nanachi.exe', async () => {
    const bad = await makePayload(join(sandbox.root, 'bad'), { 'resources/app.asar': 'x' });
    const { deps } = makeInstallDeps(sandbox, bad);
    await expect(runInstall(options({ noShortcuts: true, noRegistry: true }), deps)).rejects.toThrow(/sem Nanachi\.exe/);
    expect(readInstallMarker(sandbox.target)).toMatchObject({ complete: false });
  });

  it('does not extract a zip entry that climbs out of the folder', async () => {
    const evilDir = join(sandbox.root, 'evil');
    const evil = await makePayload(evilDir, { 'Nanachi.exe': 'MZ' });
    await writeSlipZip(evil.zipPath);
    const { deps } = makeInstallDeps(sandbox, evil);
    await expect(runInstall(options({ noShortcuts: true, noRegistry: true }), deps)).rejects.toThrow();
    expect(existsSync(join(sandbox.target, '..', 'escaped.txt'))).toBe(false);
  });

  describe('path guards', () => {
    const cases: Array<[string, () => string]> = [
      ['a drive root', () => 'C:\\'],
      ['the user profile', () => sandbox.profile],
      ['the folder that holds the user profile', () => sandbox.root],
      ['the Nanachi data folder', () => sandbox.nanachiHome],
      ['a folder inside the data folder', () => join(sandbox.nanachiHome, 'app')],
    ];
    for (const [name, target] of cases) {
      it(`refuses ${name} before touching anything`, async () => {
        mkdirSync(sandbox.nanachiHome, { recursive: true });
        writeFileSync(join(sandbox.nanachiHome, 'config.json'), '{}');
        const { deps, recorder } = makeInstallDeps(sandbox, payload);
        await expect(runInstall(options({ target: target() }), deps)).rejects.toBeInstanceOf(InstallError);
        expect(recorder.events).toEqual([]);
        expect(recorder.shortcuts).toEqual([]);
        expect(recorder.reg).toEqual([]);
        expect(readFileSync(join(sandbox.nanachiHome, 'config.json'), 'utf8')).toBe('{}');
        expect(existsSync(join(sandbox.profile, INSTALL_MARKER))).toBe(false);
      });
    }

    it('refuses a target that contains a .nanachi-remote folder', async () => {
      const holder = join(sandbox.root, 'holder');
      mkdirSync(join(holder, '.nanachi-remote'), { recursive: true });
      const { deps } = makeInstallDeps(sandbox, payload, { nanachiHome: join(sandbox.root, 'elsewhere') });
      await expect(runInstall(options({ target: holder }), deps)).rejects.toThrow(/\.nanachi-remote/);
    });
  });

  describe('a running Nanachi', () => {
    it('asks to close it and stops its processes when the user agrees', async () => {
      let running = [{ pid: 4242, name: 'Nanachi.exe' }, { pid: 4243, name: 'node.exe' }];
      const confirmClose = vi.fn(() => Promise.resolve(true));
      const { deps, recorder } = makeInstallDeps(sandbox, payload, {
        findRunning: () => Promise.resolve(running),
        confirmClose,
        stopProcesses: (pids) => {
          recorder.stopped.push(pids);
          running = [];
          return Promise.resolve();
        },
      });
      await runInstall(options({ noShortcuts: true, noRegistry: true }), deps);

      expect(confirmClose).toHaveBeenCalledWith([{ pid: 4242, name: 'Nanachi.exe' }, { pid: 4243, name: 'node.exe' }]);
      expect(recorder.stopped).toEqual([[4242, 4243]]);
      expect(existsSync(join(sandbox.target, 'Nanachi.exe'))).toBe(true);
    });

    it('stops without extracting anything when the user says no', async () => {
      const { deps, recorder } = makeInstallDeps(sandbox, payload, {
        findRunning: () => Promise.resolve([{ pid: 1, name: 'Nanachi.exe' }]),
        confirmClose: () => Promise.resolve(false),
      });
      await expect(runInstall(options({ noShortcuts: true, noRegistry: true }), deps)).rejects.toThrow(/continua aberto/);
      expect(recorder.stopped).toEqual([]);
      expect(existsSync(sandbox.target)).toBe(false);
    });

    it('does not ask when nothing runs from the folder', async () => {
      const confirmClose = vi.fn(() => Promise.resolve(true));
      const { deps } = makeInstallDeps(sandbox, payload, { confirmClose });
      await runInstall(options({ noShortcuts: true, noRegistry: true }), deps);
      expect(confirmClose).not.toHaveBeenCalled();
    });

    it('gives up with a message when a process refuses to go away', async () => {
      const { deps } = makeInstallDeps(sandbox, payload, { findRunning: () => Promise.resolve([{ pid: 9, name: 'Nanachi.exe' }]) });
      await expect(runInstall(options({ noShortcuts: true, noRegistry: true }), deps)).rejects.toThrow(/não foi possível fechar/i);
      expect(existsSync(sandbox.target)).toBe(false);
    });
  });
});
