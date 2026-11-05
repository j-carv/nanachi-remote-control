import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { t } from '../common/i18n/index.js';
import { messageOf } from '../common/message.js';
import { EXE_NAME, INSTALL_MARKER, SHORTCUT_NAME } from './constants.js';
import { assertInsideInstall, checkDataFolder, checkInstallTarget, samePath } from './guards.js';
import { type FsLike, InstallError, readInstallMarker } from './install.js';
import type { RunningProcess } from './processes.js';
import { buildUninstallRemoval, commandExecutable, type RegArgs } from './registry.js';
import { removeTree, type RemoveOptions } from './safe-remove.js';

export type UninstallStepId = 'stop' | 'shortcuts' | 'startup' | 'files' | 'data' | 'registry';

export interface UninstallOptions {
  installDir: string;
  /** "Apagar também os dados do Nanachi" (`--delete-data`). */
  deleteData: boolean;
  /** Test mode: `--no-shortcuts`. */
  noShortcuts: boolean;
  /** Test mode: `--no-registry` (the uninstall key and the login item). */
  noRegistry: boolean;
}

export interface UninstallStepPlan {
  id: UninstallStepId;
  label: string;
  weight: number;
  skipped: string | null;
}

/** The steps in order, with their texts in the language in effect when the plan is made. */
export function planUninstall(options: UninstallOptions): UninstallStepPlan[] {
  const testMode = t('installer.common.testMode');
  return [
    { id: 'stop', label: t('installer.steps.uninstall.stop'), weight: 10, skipped: null },
    { id: 'shortcuts', label: t('installer.steps.uninstall.shortcuts'), weight: 5, skipped: options.noShortcuts ? testMode : null },
    {
      id: 'startup',
      label: t('installer.steps.uninstall.startup'),
      weight: 5,
      skipped: options.noRegistry ? testMode : null,
    },
    { id: 'files', label: t('installer.steps.uninstall.files'), weight: 60, skipped: null },
    {
      id: 'data',
      label: t('installer.steps.uninstall.data'),
      weight: 10,
      skipped: options.deleteData ? null : t('installer.steps.skippedDataKept'),
    },
    {
      id: 'registry',
      label: t('installer.steps.uninstall.registry'),
      weight: 10,
      skipped: options.noRegistry ? testMode : null,
    },
  ];
}

export interface UninstallProgress {
  step: UninstallStepId;
  label: string;
  state: 'running' | 'done' | 'skipped';
  percent: number;
}

export interface UninstallDeps {
  profile: string;
  /** Desktop's own data folder (`NANACHI_DESKTOP_HOME`, default `%USERPROFILE%\.nanachi-desktop`). */
  desktopHome: string;
  /**
   * The standalone daemon's `NANACHI_HOME` from the environment, when set. Desktop never uses it; the guards refuse it
   * (and `%USERPROFILE%\.nanachi-remote`, always) as the install folder and as a data folder to delete.
   */
  standaloneDirs?: readonly string[] | undefined;
  /** Desktop's own data (`%APPDATA%\Nanachi`): the paired-device token and the Desktop settings. */
  desktopDataDir: string;
  startMenuDir: string;
  desktopDir: string;
  /** Pid of the running uninstaller: never stopped. */
  selfPid: number;
  fs?: FsLike;
  findRunning(dir: string): Promise<RunningProcess[]>;
  stopProcesses(pids: number[]): Promise<void>;
  /** Where a shortcut points, or null when it is unreadable. */
  readShortcutTarget(path: string): string | null;
  /** The Run command of "Iniciar com o Windows", or null when it is off. Rejects when the registry cannot be read. */
  readStartupCommand(): Promise<string | null>;
  removeStartup(): void;
  /** `InstallLocation` of the uninstall entry, or null when there is none. Rejects when the registry cannot be read. */
  readInstallLocation(): Promise<string | null>;
  runReg(args: RegArgs): Promise<number>;
  /** A daemon answers on the data folder's port: the folder is in use and is not deleted. */
  homeInUse(): Promise<boolean>;
  /** Deletes what a running exe still holds, after the process has exited. */
  scheduleRemoval(dirs: string[]): void;
  emit(progress: UninstallProgress): void;
  sleep?: (ms: number) => Promise<void>;
  /** Retries and waits of the folder removal (tests make them instant). */
  removeOptions?: RemoveOptions;
}

export interface UninstallResult {
  /** The install folder could not be emptied while the uninstaller ran; a detached `cmd` finishes it. */
  removalScheduled: boolean;
  /** Things that did not work but did not stop the uninstall. */
  warnings: string[];
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Something exists at `path` (a broken link counts). */
function isPresent(path: string, fs: FsLike): boolean {
  if (path === '' || path.includes('\0')) return false;
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` is a symlink or a junction itself (`lstat`, never followed). */
function isLink(path: string, fs: FsLike): boolean {
  try {
    return fs.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Removes the install folder from the inside out: every entry is deleted if it can be, the marker last. What the running
 * uninstaller itself holds (its exe and DLLs) stays, and `scheduleRemoval` clears it once the process is gone.
 * Returns true when the folder is gone.
 */
function removeInstallDir(dir: string, fs: FsLike, options: RemoveOptions | undefined): boolean {
  const names = fs.readdirSync(dir).filter((name) => name !== INSTALL_MARKER);
  for (const name of names) {
    const path = join(dir, name);
    assertInsideInstall(dir, path);
    removeTree(path, fs, options);
  }
  if (fs.readdirSync(dir).filter((name) => name !== INSTALL_MARKER).length > 0) return false;
  assertInsideInstall(dir, join(dir, INSTALL_MARKER));
  removeTree(join(dir, INSTALL_MARKER), fs, options);
  // Only the empty folder is left.
  return removeTree(dir, fs, options) && !fs.existsSync(dir);
}

/**
 * Uninstalls Nanachi: stops what runs from the folder, removes shortcuts, the login item, the files and the uninstall
 * key. The data (Desktop's data folder and profile; never the standalone daemon's) stays unless `deleteData`. Throws `InstallError` for a folder that
 * is not a Nanachi install; the folder is validated before anything is touched.
 */
export async function runUninstall(options: UninstallOptions, deps: UninstallDeps): Promise<UninstallResult> {
  const fs = deps.fs ?? nodeFs;
  const sleep = deps.sleep ?? defaultSleep;
  const check = checkInstallTarget(options.installDir, {
    profile: deps.profile,
    desktopHome: deps.desktopHome,
    standaloneDirs: deps.standaloneDirs,
    exists: fs.existsSync,
  });
  if (!check.ok) throw new InstallError(check.reason);
  const dir = check.dir;
  if (!fs.existsSync(dir) || readInstallMarker(dir, fs) === null) {
    throw new InstallError(t('installer.errors.notAnInstall'));
  }
  const exe = join(dir, EXE_NAME);
  const plan = planUninstall(options);
  const warnings: string[] = [];
  let removalScheduled = false;

  let finished = 0;
  const total = plan.reduce((sum, entry) => sum + entry.weight, 0);
  const percentOf = (done: number): number => Math.min(100, Math.round((done / total) * 100));

  async function step(id: UninstallStepId, run: () => Promise<void> | void): Promise<void> {
    const entry = plan.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new Error(`etapa desconhecida: ${id}`);
    if (entry.skipped !== null) {
      finished += entry.weight;
      deps.emit({ step: id, label: entry.label, state: 'skipped', percent: percentOf(finished) });
      return;
    }
    deps.emit({ step: id, label: entry.label, state: 'running', percent: percentOf(finished) });
    await run();
    finished += entry.weight;
    deps.emit({ step: id, label: entry.label, state: 'done', percent: percentOf(finished) });
  }

  /** What runs from the folder besides this uninstaller. */
  const others = async (): Promise<RunningProcess[]> =>
    (await deps.findRunning(dir)).filter((process) => process.pid !== deps.selfPid);

  await step('stop', async () => {
    let running: RunningProcess[];
    try {
      running = await others();
    } catch (error) {
      // Without the list the uninstall still goes on: whatever stays locked is removed by the scheduled cleanup.
      warnings.push(t('installer.errors.checkRunning', { detail: messageOf(error) }));
      return;
    }
    if (running.length === 0) return;
    await deps.stopProcesses(running.map((process) => process.pid));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await others()).length === 0) return;
      await sleep(500);
    }
    warnings.push(t('installer.warnings.processesLeft'));
  });

  await step('shortcuts', () => {
    // Only a shortcut that points at this install: a same-named shortcut of something else stays.
    for (const path of [join(deps.startMenuDir, SHORTCUT_NAME), join(deps.desktopDir, SHORTCUT_NAME)]) {
      if (!fs.existsSync(path)) continue;
      const target = deps.readShortcutTarget(path);
      if (target !== null && samePath(target, exe)) removeTree(path, fs, deps.removeOptions);
    }
  });

  await step('startup', async () => {
    // Only a login item that starts THIS install: another Nanachi (another folder) keeps its own.
    let command: string | null;
    try {
      command = await deps.readStartupCommand();
    } catch (error) {
      warnings.push(t('installer.warnings.startupUnknown', { detail: messageOf(error) }));
      return;
    }
    if (command === null) return;
    const target = commandExecutable(command);
    if (target !== null && samePath(target, exe)) deps.removeStartup();
  });

  await step('files', () => {
    const gone = removeInstallDir(dir, fs, deps.removeOptions);
    if (!gone) {
      deps.scheduleRemoval([dir]);
      removalScheduled = true;
    }
  });

  await step('data', async () => {
    if (await deps.homeInUse()) {
      warnings.push(t('installer.warnings.dataInUse'));
      return;
    }
    // Desktop's data folder needs both its config and its database; its profile needs one of its own two files. The
    // standalone daemon's folder (`.nanachi-remote`, NANACHI_HOME) is refused by both checks, whatever it holds.
    const home = checkDataFolder(deps.desktopHome, {
      profile: deps.profile,
      installDir: dir,
      others: [deps.desktopDataDir],
      standaloneDirs: deps.standaloneDirs,
      requireAll: ['config.json', 'data.db'],
      exists: fs.existsSync,
    });
    if (!home.ok) {
      // Nothing there is not a problem: there is just nothing to delete.
      if (isPresent(deps.desktopHome, fs)) warnings.push(t('installer.warnings.dataNotDeleted', { path: deps.desktopHome, reason: home.reason }));
    } else {
      const wasLink = isLink(home.dir, fs);
      if (!removeTree(home.dir, fs, deps.removeOptions)) {
        warnings.push(t('installer.warnings.dataPartial', { path: home.dir }));
      } else if (wasLink) {
        warnings.push(t('installer.warnings.dataLink', { path: home.dir }));
      }
    }

    const profile = checkDataFolder(deps.desktopDataDir, {
      profile: deps.profile,
      installDir: dir,
      others: [deps.desktopHome],
      standaloneDirs: deps.standaloneDirs,
      requireAny: ['machine.bin', 'desktop-settings.json'],
      exists: fs.existsSync,
    });
    if (profile.ok && !removeTree(profile.dir, fs, deps.removeOptions)) {
      warnings.push(t('installer.warnings.profilePartial', { path: profile.dir }));
    }
  });

  await step('registry', async () => {
    // Only the entry that describes THIS install: after a second install elsewhere the key belongs to that one.
    let location: string | null;
    try {
      location = await deps.readInstallLocation();
    } catch (error) {
      warnings.push(t('installer.warnings.registryUnreadable', { detail: messageOf(error) }));
      return;
    }
    if (location === null) return;
    if (location.trim() === '' || !samePath(location, dir)) {
      warnings.push(t('installer.warnings.registryOther'));
      return;
    }
    const code = await deps.runReg(buildUninstallRemoval());
    // 1 is "the key does not exist": already clean.
    if (code !== 0 && code !== 1) warnings.push(t('installer.warnings.registryRemoveFailed'));
  });

  return { removalScheduled, warnings };
}
