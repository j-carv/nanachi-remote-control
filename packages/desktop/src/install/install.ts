import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { t } from '../common/i18n/index.js';
import { messageOf } from '../common/message.js';
import { APP_USER_MODEL_ID, EXE_NAME, INSTALL_MARKER, PRODUCT_NAME, SHORTCUT_NAME } from './constants.js';
import { assertInsideInstall, checkInstallTarget } from './guards.js';
import type { Payload } from './payload.js';
import type { RunningProcess } from './processes.js';
import { buildUninstallEntry, type RegArgs } from './registry.js';
import { removeTree, type RemoveFs, type RemoveOptions } from './safe-remove.js';

/**
 * The part of `fs` the planner uses. The uninstaller inside Electron passes `original-fs` (no asar interception).
 * There is no `rmSync` on purpose: every delete goes through `removeTree`, which never follows a junction.
 */
export type FsLike = Pick<typeof nodeFs, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'statSync' | 'writeFileSync'> & RemoveFs;

export class InstallError extends Error {
  override name = 'InstallError';
}

export type InstallStepId = 'close' | 'extract' | 'shortcuts' | 'startup' | 'registry';

export interface InstallOptions {
  target: string;
  desktopShortcut: boolean;
  startWithWindows: boolean;
  /** Test mode: `--no-shortcuts`. */
  noShortcuts: boolean;
  /** Test mode: `--no-registry` (the uninstall key and the login item). */
  noRegistry: boolean;
}

export interface InstallStepPlan {
  id: InstallStepId;
  /** Shown next to the progress bar, in the language in effect when the plan is made. */
  label: string;
  /** Share of the progress bar. */
  weight: number;
  /** Why the step does nothing, or null when it runs. */
  skipped: string | null;
}

/**
 * The steps in order, with what each one will do for these options. The launch is the user's click, not a step. The texts are
 * written in the language in effect when the plan is made.
 */
export function planInstall(options: InstallOptions): InstallStepPlan[] {
  const testMode = t('installer.common.testMode');
  return [
    { id: 'close', label: t('installer.steps.install.close'), weight: 2, skipped: null },
    { id: 'extract', label: t('installer.steps.install.extract'), weight: 90, skipped: null },
    {
      id: 'shortcuts',
      label: t('installer.steps.install.shortcuts'),
      weight: 3,
      skipped: options.noShortcuts ? testMode : null,
    },
    {
      id: 'startup',
      label: t('installer.steps.install.startup'),
      weight: 2,
      skipped: options.noRegistry ? testMode : options.startWithWindows ? null : t('installer.steps.skippedOff'),
    },
    {
      id: 'registry',
      label: t('installer.steps.install.registry'),
      weight: 3,
      skipped: options.noRegistry ? testMode : null,
    },
  ];
}

export interface InstallProgress {
  step: InstallStepId;
  label: string;
  state: 'running' | 'done' | 'skipped';
  /** Whole bar, 0 to 100. */
  percent: number;
}

export interface ShortcutSpec {
  path: string;
  target: string;
  cwd: string;
  icon: string;
  iconIndex: number;
  description: string;
  appUserModelId: string;
}

export interface InstallDeps {
  payload: Payload;
  profile: string;
  /** Desktop's own data folder (`NANACHI_DESKTOP_HOME`, default `%USERPROFILE%\.nanachi-desktop`). */
  desktopHome: string;
  /**
   * The standalone daemon's `NANACHI_HOME` from the environment, when set. Desktop never uses it; the guard refuses it
   * (and `%USERPROFILE%\.nanachi-remote`, always) as an install target.
   */
  standaloneDirs?: readonly string[] | undefined;
  /** `%APPDATA%\Microsoft\Windows\Start Menu\Programs`. */
  startMenuDir: string;
  desktopDir: string;
  /** Unzips `zipPath` into `dir`, reporting the uncompressed bytes written so far. */
  extract(zipPath: string, dir: string, onBytes: (done: number) => void): Promise<void>;
  findRunning(dir: string): Promise<RunningProcess[]>;
  stopProcesses(pids: number[]): Promise<void>;
  /** Asks the user to close a running Nanachi. `false` cancels the install. */
  confirmClose(processes: RunningProcess[]): Promise<boolean>;
  writeShortcut(spec: ShortcutSpec): boolean;
  setStartup(enabled: boolean, exePath: string): void;
  /** Runs `reg.exe`; resolves with its exit code. */
  runReg(args: RegArgs): Promise<number>;
  emit(progress: InstallProgress): void;
  fs?: FsLike;
  exists?: (path: string) => boolean;
  /** Waits between checks that a stopped process is really gone. */
  sleep?: (ms: number) => Promise<void>;
  /** Retries and waits of the removal of an earlier install (tests make them instant). */
  removeOptions?: RemoveOptions;
}

export interface InstallResult {
  installDir: string;
  exe: string;
  version: string;
}

interface Marker {
  version: string;
  installedAt: string;
  complete: boolean;
}

export function readInstallMarker(dir: string, fs: FsLike = nodeFs): Marker | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(join(dir, INSTALL_MARKER), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const { version, installedAt, complete } = raw as Record<string, unknown>;
    if (typeof version !== 'string' || typeof installedAt !== 'string') return null;
    return { version, installedAt, complete: complete === true };
  } catch {
    return null;
  }
}

function writeMarker(dir: string, marker: Marker, fs: FsLike): void {
  fs.writeFileSync(join(dir, INSTALL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

/**
 * A new folder, an empty one, or an earlier Nanachi install (it carries the marker) can receive the files; anything else
 * is refused so an install never mixes into somebody's folder. An earlier install is cleared first, except the marker:
 * it is rewritten as `complete: false` before anything is deleted and stays, so an upgrade that fails halfway still
 * leaves a folder the installer and the uninstaller recognise.
 */
function prepareTarget(dir: string, fs: FsLike, incomplete: Marker, removeOptions: RemoveOptions | undefined): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    writeMarker(dir, incomplete, fs);
    return;
  }
  if (!fs.statSync(dir).isDirectory()) throw new InstallError(t('installer.errors.targetIsFile'));
  const entries = fs.readdirSync(dir);
  if (entries.length > 0 && readInstallMarker(dir, fs) === null) {
    throw new InstallError(t('installer.errors.targetNotEmpty'));
  }
  writeMarker(dir, incomplete, fs);
  for (const name of entries) {
    if (name === INSTALL_MARKER) continue;
    const path = join(dir, name);
    assertInsideInstall(dir, path);
    if (!removeTree(path, fs, removeOptions)) {
      throw new InstallError(t('installer.errors.cannotReplace', { name }));
    }
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** Stops what the user agreed to close, then waits (up to 10 s) until nothing of the folder is left running. */
async function closeRunning(dir: string, deps: InstallDeps): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const scan = async (): Promise<RunningProcess[]> => {
    try {
      return await deps.findRunning(dir);
    } catch (error) {
      throw new InstallError(t('installer.errors.checkRunning', { detail: messageOf(error) }));
    }
  };
  const running = await scan();
  if (running.length === 0) return;
  if (!(await deps.confirmClose(running))) {
    throw new InstallError(t('installer.errors.installCancelled'));
  }
  await deps.stopProcesses(running.map((process) => process.pid));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await scan()).length === 0) return;
    await sleep(500);
  }
  throw new InstallError(t('installer.errors.cannotClose'));
}

/**
 * Installs the payload. Per user, no admin. The steps and their order are `planInstall`; a step that is skipped only
 * reports it. Throws `InstallError` with a message for the user. A failed install leaves the marker with
 * `complete: false`, so running the installer again over the same folder works.
 */
export async function runInstall(options: InstallOptions, deps: InstallDeps): Promise<InstallResult> {
  const fs = deps.fs ?? nodeFs;
  const exists = deps.exists ?? fs.existsSync;
  const check = checkInstallTarget(options.target, {
    profile: deps.profile,
    desktopHome: deps.desktopHome,
    standaloneDirs: deps.standaloneDirs,
    exists,
  });
  if (!check.ok) throw new InstallError(check.reason);
  const dir = check.dir;
  const exe = join(dir, EXE_NAME);
  const plan = planInstall(options);

  let finished = 0;
  const total = plan.reduce((sum, step) => sum + step.weight, 0);
  const percentOf = (done: number): number => Math.min(100, Math.round((done / total) * 100));

  async function step(id: InstallStepId, run: (report: (fraction: number) => void) => Promise<void> | void): Promise<void> {
    const entry = plan.find((candidate) => candidate.id === id);
    if (entry === undefined) throw new Error(`etapa desconhecida: ${id}`);
    if (entry.skipped !== null) {
      finished += entry.weight;
      deps.emit({ step: id, label: entry.label, state: 'skipped', percent: percentOf(finished) });
      return;
    }
    deps.emit({ step: id, label: entry.label, state: 'running', percent: percentOf(finished) });
    let lastPercent = percentOf(finished);
    await run((fraction) => {
      const clamped = Math.max(0, Math.min(1, fraction));
      const percent = percentOf(finished + entry.weight * clamped);
      // Extraction reports once per zip entry (thousands); the bar only needs the percent to change.
      if (percent === lastPercent) return;
      lastPercent = percent;
      deps.emit({ step: id, label: entry.label, state: 'running', percent });
    });
    finished += entry.weight;
    deps.emit({ step: id, label: entry.label, state: 'done', percent: percentOf(finished) });
  }

  await step('close', async () => {
    await closeRunning(dir, deps);
  });

  await step('extract', async (report) => {
    const now = new Date().toISOString();
    prepareTarget(dir, fs, { version: deps.payload.meta.version, installedAt: now, complete: false }, deps.removeOptions);
    await deps.extract(deps.payload.zipPath, dir, (bytes) => report(bytes / deps.payload.meta.uncompressedBytes));
    if (!exists(exe)) throw new InstallError(t('installer.errors.missingExe', { exe: EXE_NAME }));
    writeMarker(dir, { version: deps.payload.meta.version, installedAt: now, complete: true }, fs);
  });

  await step('shortcuts', () => {
    const specs = [join(deps.startMenuDir, SHORTCUT_NAME)];
    if (options.desktopShortcut) specs.push(join(deps.desktopDir, SHORTCUT_NAME));
    for (const path of specs) {
      fs.mkdirSync(dirname(path), { recursive: true });
      const created = deps.writeShortcut({
        path,
        target: exe,
        cwd: dir,
        icon: exe,
        iconIndex: 0,
        description: PRODUCT_NAME,
        appUserModelId: APP_USER_MODEL_ID,
      });
      if (!created) throw new InstallError(t('installer.errors.shortcutFailed', { path }));
    }
  });

  await step('startup', () => {
    deps.setStartup(true, exe);
  });

  await step('registry', async () => {
    const sizeKb = Math.ceil(deps.payload.meta.uncompressedBytes / 1024);
    for (const args of buildUninstallEntry({ installDir: dir, version: deps.payload.meta.version, estimatedSizeKb: sizeKb })) {
      const code = await deps.runReg(args);
      if (code !== 0) throw new InstallError(t('installer.errors.registryFailed'));
    }
  });

  return { installDir: dir, exe, version: deps.payload.meta.version };
}
