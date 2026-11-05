import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, type BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, shell } from 'electron';
import { DEFAULT_LANGUAGE, setLanguage, t, type Language } from '../common/i18n/index.js';
import { messageOf } from '../common/message.js';
import { parseInstallFlags } from '../install/args.js';
import { APP_USER_MODEL_ID } from '../install/constants.js';
import type { FsLike } from '../install/install.js';
import {
  type UninstallerInit,
  UNINSTALLER_CHANNELS as channels,
  type UninstallOutcome,
} from '../install/ipc.js';
import { findRunningInDir, stopProcessTrees } from '../install/processes.js';
import { scheduleRemoval } from '../install/removal.js';
import { readInstallLocation, readStartupCommand, runReg } from '../install/registry.js';
import { isOwnWindowCaller } from '../install/sender.js';
import { runUninstall, type UninstallProgress } from '../install/uninstall.js';
import { createShellWindow } from '../install/window.js';
import { HIDDEN_ARG } from './autostart.js';
import { readConfiguredPort, resolveHome, standaloneHomes } from './daemon-runtime.js';
import { fetchHealth } from './system.js';
import { readUninstallLanguage } from './uninstall-language.js';

/**
 * `Nanachi.exe --uninstall`, what the Windows "Apps" page runs: a confirmation window in the installer's style, then the
 * removal. It never takes the single-instance lock (the tray app may be running and is closed as a step) and it keeps
 * its own Chromium profile in a temp folder, so it leaves nothing behind in `%APPDATA%`.
 *
 * Test mode, as in the installer: `--target <dir> --no-shortcuts --no-registry`, plus `--yes` to skip the question and
 * `--delete-data` for the unticked-by-default "Apagar também os dados do Nanachi".
 */

const require = createRequire(import.meta.url);
/** `original-fs`: plain `fs` without Electron's asar interception, or deleting `resources/app.asar` would fail. */
const originalFs = require('original-fs') as FsLike;

export function runUninstaller(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // Desktop's own profile (paired-device token, settings): computed before this process points userData at a temp folder.
  const override = process.env.NANACHI_DESKTOP_USER_DATA;
  const desktopDataDir = override !== undefined && override !== '' ? override : app.getPath('userData');
  // The window speaks the language Desktop is set to; without a setting (it never ran) the system's. The locale is only
  // known once the app is ready, so the language is picked there.
  let language: Language = DEFAULT_LANGUAGE;
  function pickLanguage(): void {
    language = readUninstallLanguage(join(desktopDataDir, 'desktop-settings.json'), app.getLocale());
    setLanguage(language);
  }

  let flags: ReturnType<typeof parseInstallFlags>;
  try {
    flags = parseInstallFlags(process.argv.slice(1));
  } catch (error) {
    void app.whenReady().then(() => {
      pickLanguage();
      dialog.showErrorBox(t('installer.uninstall.title'), messageOf(error));
      app.exit(2);
    });
    return;
  }

  const uiProfile = join(tmpdir(), 'nanachi-uninstall-ui');
  app.setPath('userData', uiProfile);
  app.setAppUserModelId(APP_USER_MODEL_ID);

  const installDir = flags.target ?? (app.isPackaged ? dirname(process.execPath) : null);
  const testMode = flags.target !== null || flags.noShortcuts || flags.noRegistry;
  // Desktop's own data folder; the standalone daemon's (NANACHI_HOME) is only ever passed on to be refused.
  const desktopHome = resolveHome(process.env);
  const standaloneDirs = standaloneHomes(process.env);
  const profile = homedir();
  const pendingRemovals: string[] = [];
  let window: BrowserWindow | null = null;
  let running = false;

  function send(progress: UninstallProgress): void {
    if (window !== null && !window.isDestroyed()) window.webContents.send(channels.progress, progress);
  }

  let finalized = false;
  /** The detached `wscript.exe` that clears what the running exe held; started once, at exit. */
  function finalize(): void {
    if (finalized) return;
    finalized = true;
    // One detached `wscript.exe` per folder: a path it refuses is left in place without holding the others back.
    for (const dir of [...pendingRemovals, uiProfile]) {
      try {
        scheduleRemoval([dir]);
      } catch {
        // Left in place.
      }
    }
  }

  async function uninstall(deleteData: boolean): Promise<UninstallOutcome> {
    if (installDir === null) return { ok: false, message: t('installer.uninstall.openFromInstalled') };
    if (running) return { ok: false, message: t('installer.uninstall.alreadyRunning') };
    running = true;
    try {
      const result = await runUninstall(
        { installDir, deleteData, noShortcuts: flags.noShortcuts, noRegistry: flags.noRegistry },
        {
          profile,
          desktopHome,
          standaloneDirs,
          desktopDataDir,
          startMenuDir: join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
          desktopDir: app.getPath('desktop'),
          selfPid: process.pid,
          fs: originalFs,
          findRunning: (dir) => findRunningInDir(dir, process.pid),
          stopProcesses: stopProcessTrees,
          readShortcutTarget: (path) => {
            try {
              return shell.readShortcutLink(path).target ?? null;
            } catch {
              return null;
            }
          },
          readStartupCommand,
          readInstallLocation,
          removeStartup: () =>
            app.setLoginItemSettings({
              openAtLogin: false,
              path: join(installDir, 'Nanachi.exe'),
              args: [HIDDEN_ARG],
              name: APP_USER_MODEL_ID,
            }),
          runReg,
          homeInUse: async () => (await fetchHealth(readConfiguredPort(desktopHome))).kind !== 'none',
          scheduleRemoval: (dirs) => pendingRemovals.push(...dirs),
          emit: send,
        },
      );
      return { ok: true, warnings: result.warnings };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    } finally {
      running = false;
    }
  }

  const windowId = (): number | null => (window === null || window.isDestroyed() ? null : window.webContents.id);

  /** Only the page this process loaded may call in (see `isOwnWindowCaller`). */
  function assertOwnPage(event: IpcMainEvent | IpcMainInvokeEvent): void {
    if (!isOwnWindowCaller(event, windowId())) {
      throw new Error('chamada recusada: origem não confiável');
    }
  }

  ipcMain.handle(channels.init, (event): UninstallerInit => {
    assertOwnPage(event);
    return {
      installDir: installDir ?? '',
      version: app.getVersion(),
      dataDir: desktopHome,
      testMode,
      deleteData: flags.deleteData,
      language,
    };
  });
  ipcMain.handle(channels.start, (event, request: unknown): Promise<UninstallOutcome> => {
    assertOwnPage(event);
    const deleteData = typeof request === 'object' && request !== null ? (request as { deleteData?: unknown }).deleteData : undefined;
    if (typeof deleteData !== 'boolean') return Promise.resolve({ ok: false, message: t('installer.errors.invalidRequest') });
    return uninstall(deleteData);
  });
  ipcMain.on(channels.minimize, (event) => {
    if (isOwnWindowCaller(event, windowId())) window?.minimize();
  });
  ipcMain.on(channels.close, (event) => {
    if (isOwnWindowCaller(event, windowId()) && !running) window?.close();
  });

  app.on('window-all-closed', () => {
    finalize();
    app.exit(0);
  });

  void app.whenReady().then(() => {
    pickLanguage();
    window = createShellWindow({
      width: 584,
      height: 464,
      title: t('installer.uninstall.title'),
      preloadPath: join(here, '..', 'preload', 'uninstall.cjs'),
      htmlPath: join(here, '..', 'ui', 'uninstall.html'),
      iconPath: join(here, '..', 'ui', 'icon.png'),
      visible: !flags.yes,
      onLoadError: (error) => {
        dialog.showErrorBox(t('installer.uninstall.title'), t('installer.uninstall.windowOpenFailed', { detail: error.message }));
        app.exit(2);
      },
    });
    window.on('close', (event) => {
      if (running) event.preventDefault();
    });
    window.on('closed', () => {
      window = null;
    });
    if (flags.yes) {
      window.webContents.once('did-finish-load', () => {
        void uninstall(flags.deleteData).then((outcome) => {
          finalize();
          setTimeout(() => app.exit(outcome.ok ? 0 : 1), 300);
        });
      });
    }
  });
}
