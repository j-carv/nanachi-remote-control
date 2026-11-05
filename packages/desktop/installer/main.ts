import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, dialog, type BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, shell } from 'electron';
import { messageOf } from '../src/common/message.js';
import { resolveHome } from '../src/main/daemon-runtime.js';
import { HIDDEN_ARG } from '../src/main/autostart.js';
import { parseInstallFlags } from '../src/install/args.js';
import { APP_USER_MODEL_ID, PAYLOAD_DIR } from '../src/install/constants.js';
import { extractPayload } from '../src/install/extract.js';
import { checkInstallTarget } from '../src/install/guards.js';
import { type InstallProgress, type InstallOptions, runInstall } from '../src/install/install.js';
import {
  INSTALLER_CHANNELS as channels,
  type InstallerInit,
  type InstallOutcome,
  type InstallRequest,
} from '../src/install/ipc.js';
import { readPayload } from '../src/install/payload.js';
import { findRunningInDir, type RunningProcess, stopProcessTrees } from '../src/install/processes.js';
import { runReg } from '../src/install/registry.js';
import { scheduleRemoval } from '../src/install/removal.js';
import { isOwnWindowCaller } from '../src/install/sender.js';
import { createShellWindow } from '../src/install/window.js';

/**
 * The installer app (its own Electron entry, bundled by `scripts/build-ui.ts` and packaged as one portable exe that
 * carries the Nanachi app as `resources/payload/payload.zip`). Per user, no admin.
 *
 * Test mode: `--target <dir> --no-shortcuts --no-registry --no-launch`, plus `--yes` to run without a click. Nothing
 * outside `--target` is touched when all of them are given.
 */

const logFile = process.env.NANACHI_INSTALLER_LOG;
function log(line: string): void {
  if (logFile === undefined || logFile === '') return;
  try {
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The log is only a debugging aid.
  }
}

function fail(message: string): never {
  log(`erro: ${message}`);
  dialog.showErrorBox('Instalador do Nanachi', message);
  exitNow(2);
  throw new Error(message);
}

// The installer's own Chromium profile goes to a throwaway folder, not to %APPDATA%. Chromium holds it open while this
// process runs, so it is removed by a detached `cmd` once the process is gone (`cleanUp`, at every way out).
const uiProfile = join(tmpdir(), 'nanachi-setup-ui');
app.setPath('userData', uiProfile);
app.setAppUserModelId('org.nanachi.setup');

let cleanedUp = false;
function cleanUp(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    scheduleRemoval([uiProfile]);
  } catch {
    // A path `cmd` cannot take safely stays where it is.
  }
}
/** `app.exit` skips `will-quit`, so every exit of this process goes through here. */
function exitNow(code: number): void {
  cleanUp();
  app.exit(code);
}

let flags: ReturnType<typeof parseInstallFlags>;
try {
  flags = parseInstallFlags(process.argv.slice(1));
} catch (error) {
  flags = parseInstallFlags([]);
  void app.whenReady().then(() => fail(messageOf(error)));
}

const testMode = flags.target !== null || flags.noShortcuts || flags.noRegistry || flags.noLaunch;
const profile = homedir();
const nanachiHome = resolveHome(process.env);
const localAppData = process.env.LOCALAPPDATA ?? join(profile, 'AppData', 'Local');
const defaultTarget = join(localAppData, 'Programs', 'Nanachi');

let window: BrowserWindow | null = null;
let installing = false;
let installedExe: string | null = null;
let pendingCloseAnswer: ((proceed: boolean) => void) | null = null;

function payloadDir(): string {
  const override = process.env.NANACHI_INSTALLER_PAYLOAD;
  if (!app.isPackaged && override !== undefined && override !== '') return override;
  return join(process.resourcesPath, PAYLOAD_DIR);
}

function send(channel: string, value: unknown): void {
  if (window !== null && !window.isDestroyed()) window.webContents.send(channel, value);
}

function askToClose(processes: RunningProcess[]): Promise<boolean> {
  if (flags.yes) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    pendingCloseAnswer = resolvePromise;
    send(channels.askClose, processes);
  });
}

async function install(request: InstallRequest): Promise<InstallOutcome> {
  if (installing) return { ok: false, message: 'A instalação já está em andamento.' };
  installing = true;
  const options: InstallOptions = {
    target: request.target,
    desktopShortcut: request.desktopShortcut,
    startWithWindows: request.startWithWindows,
    noShortcuts: flags.noShortcuts,
    noRegistry: flags.noRegistry,
  };
  try {
    const payload = readPayload(payloadDir());
    const result = await runInstall(options, {
      payload,
      profile,
      nanachiHome,
      startMenuDir: join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      desktopDir: app.getPath('desktop'),
      extract: extractPayload,
      findRunning: (dir) => findRunningInDir(dir, process.pid),
      stopProcesses: stopProcessTrees,
      confirmClose: askToClose,
      writeShortcut: (spec) =>
        shell.writeShortcutLink(spec.path, 'create', {
          target: spec.target,
          cwd: spec.cwd,
          icon: spec.icon,
          iconIndex: spec.iconIndex,
          description: spec.description,
          appUserModelId: spec.appUserModelId,
        }),
      // Same call the installed app makes for itself, pointed at its exe: the value name is its AppUserModelId.
      setStartup: (enabled, exePath) =>
        app.setLoginItemSettings({ openAtLogin: enabled, path: exePath, args: [HIDDEN_ARG], name: APP_USER_MODEL_ID }),
      runReg,
      emit: (progress: InstallProgress) => {
        log(`${progress.state} ${progress.step} ${progress.percent}%`);
        send(channels.progress, progress);
      },
    });
    installedExe = result.exe;
    log(`instalado em ${result.installDir} (versão ${result.version})`);
    return { ok: true };
  } catch (error) {
    const message = messageOf(error);
    log(`erro: ${message}`);
    return { ok: false, message };
  } finally {
    installing = false;
  }
}

function launchInstalled(): void {
  if (installedExe === null) return;
  const child = spawn(installedExe, [], { detached: true, stdio: 'ignore', cwd: join(installedExe, '..') });
  child.unref();
  log(`iniciou ${installedExe}`);
}

/** Web contents id of the installer window, or null when there is none. */
const windowId = (): number | null => (window === null || window.isDestroyed() ? null : window.webContents.id);

/** Only the page this process loaded may call in: the handlers below extract files and write the registry. */
function assertOwnPage(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isOwnWindowCaller(event, windowId())) throw new Error('chamada recusada: origem não confiável');
}

function registerIpc(): void {
  ipcMain.handle(channels.init, (event): InstallerInit => {
    assertOwnPage(event);
    return {
      version: app.getVersion(),
      target: flags.target ?? defaultTarget,
      desktopShortcut: true,
      startWithWindows: true,
      testMode,
    };
  });
  ipcMain.handle(channels.chooseFolder, async (event, current: unknown) => {
    assertOwnPage(event);
    if (window === null) return null;
    const result = await dialog.showOpenDialog(window, {
      title: 'Pasta de instalação',
      defaultPath: typeof current === 'string' && current !== '' ? current : defaultTarget,
      properties: ['openDirectory', 'createDirectory'],
    });
    const chosen = result.filePaths[0];
    return result.canceled || chosen === undefined ? null : chosen;
  });
  ipcMain.handle(channels.validateTarget, (event, target: unknown) => {
    assertOwnPage(event);
    if (typeof target !== 'string') return { ok: false, reason: 'Escolha uma pasta para instalar o Nanachi.' };
    const check = checkInstallTarget(target, { profile, nanachiHome });
    return check.ok ? { ok: true } : { ok: false, reason: check.reason };
  });
  ipcMain.handle(channels.start, (event, request: unknown): Promise<InstallOutcome> => {
    assertOwnPage(event);
    if (typeof request !== 'object' || request === null) return Promise.resolve({ ok: false, message: 'Pedido inválido.' });
    const { target, desktopShortcut, startWithWindows } = request as Record<string, unknown>;
    if (typeof target !== 'string' || typeof desktopShortcut !== 'boolean' || typeof startWithWindows !== 'boolean') {
      return Promise.resolve({ ok: false, message: 'Pedido inválido.' });
    }
    return install({ target, desktopShortcut, startWithWindows });
  });
  ipcMain.on(channels.answerClose, (event, proceed: unknown) => {
    if (!isOwnWindowCaller(event, windowId())) return;
    const answer = pendingCloseAnswer;
    pendingCloseAnswer = null;
    answer?.(proceed === true);
  });
  ipcMain.handle(channels.launch, (event) => {
    assertOwnPage(event);
    launchInstalled();
    setTimeout(() => app.quit(), 300);
  });
  ipcMain.on(channels.minimize, (event) => {
    if (isOwnWindowCaller(event, windowId())) window?.minimize();
  });
  ipcMain.on(channels.close, (event) => {
    if (isOwnWindowCaller(event, windowId()) && !installing) window?.close();
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  registerIpc();
  const here = __dirname;
  window = createShellWindow({
    width: 744,
    height: 464,
    title: 'Instalador do Nanachi',
    preloadPath: join(here, 'preload.cjs'),
    htmlPath: join(here, 'ui', 'installer.html'),
    iconPath: join(here, 'ui', 'icon.png'),
    visible: !flags.yes,
    onLoadError: (error) => fail(`Não foi possível abrir o instalador: ${error.message}`),
  });
  window.on('close', (event) => {
    if (installing) event.preventDefault();
  });
  window.on('closed', () => {
    window = null;
  });
  if (flags.yes) {
    window.webContents.once('did-finish-load', () => {
      void install({ target: flags.target ?? defaultTarget, desktopShortcut: true, startWithWindows: true }).then((outcome) => {
        if (outcome.ok && !flags.noLaunch) launchInstalled();
        log(outcome.ok ? 'concluído' : `falhou: ${outcome.message}`);
        setTimeout(() => exitNow(outcome.ok ? 0 : 1), 400);
      });
    });
  }
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', cleanUp);
log(`argumentos: ${process.argv.slice(1).join(' ')}`);
void main();
