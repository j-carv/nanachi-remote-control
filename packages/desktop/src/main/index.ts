import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, ipcMain, Notification, safeStorage, session, shell } from 'electron';
import { CONTROL_EVENT_CHANNELS, EVENT_CHANNELS } from '../common/channels.js';
import { messageOf } from '../common/message.js';
import type { DaemonStatus, TailscaleStatus } from '../common/types.js';
import { APP_USER_MODEL_ID, UNINSTALL_ARG } from '../install/constants.js';
import { createAutostart, HIDDEN_ARG } from './autostart.js';
import { resolveBuildDir } from './build-dir.js';
import { registerControlIpc } from './control-ipc.js';
import { createControlService } from './control-service.js';
import { createControlWindow } from './control-window.js';
import { DaemonHost } from './daemon-host.js';
import { createDaemonApi, createTokenAccess } from './daemon-api.js';
import { ensureDesktopConfig, missingRuntimeFile, readConfiguredPort, resolveHome, resolveRuntime } from './daemon-runtime.js';
import { createDriveLister } from './drives.js';
import { registerIpc } from './ipc.js';
import { createRotatingLog, readDesktopLogs } from './log-file.js';
import { createDeviceAddRunner, createPairCliRunner } from './pair-cli.js';
import { createPanel } from './panel.js';
import { daemonOrigin, isSameOrigin } from './panel-policy.js';
import { createPairing, createTokenStore, desktopDeviceName } from './pairing.js';
import { createPairingWindow } from './pairing-window.js';
import { createRootsStore } from './roots-config.js';
import { createSettingsStore } from './settings.js';
import { fetchHealth, isPortFree, killProcessTree, runProcess, spawnHidden, spawnSidecar } from './system.js';
import { createTray } from './tray.js';
import { createTsnetHost, resolveSidecarPath, tsnetHostname } from './tsnet-host.js';
import { launchUninstaller } from './uninstall-launch.js';
import { checkForUpdate } from './updates.js';
import { runUninstaller } from './uninstall-app.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

const startHidden = process.argv.includes(HIDDEN_ARG);
/** Brings the main window (the control center) to the front; set once Desktop has booted. */
let openMainRequest: (() => void) | null = null;

if (process.argv.includes(UNINSTALL_ARG)) {
  // `Nanachi.exe --uninstall` (the Windows "Apps" page): its own small window, no tray, no daemon, no instance lock.
  runUninstaller();
} else {
  startDesktop();
}

function startDesktop(): void {
  // Tests and smoke runs point Desktop at a throwaway profile. This must happen before the single-instance lock,
  // which is keyed by the user data folder.
  const userDataOverride = process.env.NANACHI_DESKTOP_USER_DATA;
  if (userDataOverride !== undefined && userDataOverride !== '') app.setPath('userData', userDataOverride);
  app.setAppUserModelId(APP_USER_MODEL_ID);

  if (!app.requestSingleInstanceLock()) {
    // Another Nanachi Desktop owns the tray; it gets a `second-instance` event and shows its control center.
    app.quit();
  } else {
    app.on('second-instance', () => openMainRequest?.());
    // A tray app keeps running with no window open.
    app.on('window-all-closed', () => undefined);
    void app.whenReady().then(boot);
  }
}

async function boot(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..', '..', '..');
  const userData = app.getPath('userData');
  // Desktop's own data folder (NANACHI_DESKTOP_HOME or ~/.nanachi-desktop), never the standalone daemon's NANACHI_HOME.
  const home = resolveHome(process.env);
  // Best effort, as early as possible: a daemon CLI that runs first on a fresh folder (a pairing code from the tray)
  // would write a config with port 7777. The host repeats this before every spawn and reports a failure.
  try {
    ensureDesktopConfig(home);
  } catch {
    // Reported by the daemon host.
  }

  const runtime = resolveRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot });
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'runtime', 'assets', 'icon-192.png')
    : join(repoRoot, 'packages', 'pwa', 'public', 'icon-192.png');
  const preloadPath = join(here, '..', 'preload', 'index.cjs');
  const controlPreloadPath = join(here, '..', 'preload', 'control.cjs');
  // `dist/control/index.html`, built by the renderer build (`build:desktop`).
  const controlIndexPath = join(here, '..', 'control', 'index.html');

  const logFile = join(home, 'desktop-daemon.log');
  const log = createRotatingLog({ file: logFile, maxBytes: MAX_LOG_BYTES });
  const note = (text: string): void => log.append(`[desktop] ${text}\n`);

  const host = new DaemonHost({
    home,
    runtime,
    readPort: () => readConfiguredPort(home),
    ensureConfig: (target) => void ensureDesktopConfig(target),
    health: (port) => fetchHealth(port),
    spawn: spawnHidden,
    killTree: killProcessTree,
    log,
    missingFile: (target) => missingRuntimeFile(target),
    portFree: (port) => isPortFree(port),
    // Windows has no polite signal for a hidden process: the tree is killed right away (`taskkill /T /F`).
    gracefulStopMs: process.platform === 'win32' ? 0 : 5_000,
  });

  const pairing = createPairing({
    runPairCli: createPairCliRunner(runtime, home),
    // Desktop's own device: `device add`, not `pair --json`, which would drop a code the user is typing on the phone.
    runDeviceAddCli: createDeviceAddRunner(runtime, home),
    fetchImpl: fetch,
    store: createTokenStore(join(userData, 'machine.bin'), safeStorage),
    baseUrl: () => daemonOrigin(host.port()),
    deviceName: desktopDeviceName(hostname()),
  });

  const settings = createSettingsStore(join(userData, 'desktop-settings.json'));
  // The sidecar: packaged it is resources/bin, in development <build dir>/stage/bin (outside the repo). It only
  // starts when the user turns "Tailscale embutido" on. NANACHI_DESKTOP_TSNET_PATH (unpackaged only) is for tests.
  const tsnet = createTsnetHost({
    exePath: () =>
      resolveSidecarPath({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        buildDir: app.isPackaged ? '' : resolveBuildDir(process.env),
        env: process.env,
      }),
    exists: existsSync,
    stateDir: join(home, 'tsnet'),
    hostname: tsnetHostname(hostname()),
    target: () => daemonOrigin(host.port()),
    spawn: spawnSidecar,
    killTree: killProcessTree,
    log,
  });
  const autostart = createAutostart(app, app.isPackaged);

  const pairingWindow = createPairingWindow({ generate: () => pairing.generateCode(), iconPath });

  const panel = createPanel({
    origin: () => daemonOrigin(host.port()),
    daemonStatus: () => host.status(),
    preloadPath,
    iconPath,
    prepare: async () => {
      try {
        await pairing.ensureMachine();
      } catch (error) {
        note(`pareamento do Desktop falhou: ${messageOf(error)}`);
        throw error;
      }
    },
  });

  /** The PWA window (sessions and chat). */
  function openSessions(): void {
    panel.open().catch((error: unknown) => note(`não foi possível abrir as sessões: ${messageOf(error)}`));
  }

  // The control center is the main window. Without its page on disk (the renderer was not built) it says so in the log
  // and the sessions window opens instead, so Desktop is never left with nothing to open.
  const control = createControlWindow({
    indexPath: controlIndexPath,
    preloadPath: controlPreloadPath,
    iconPath,
    bounds: {
      load: () => settings.get().controlWindow,
      save: (bounds) => void settings.update({ controlWindow: bounds }),
    },
    onMissingUi: openSessions,
    note,
  });
  function openControl(): void {
    control.open();
  }
  openMainRequest = openControl;

  function showPairingCode(): void {
    pairingWindow.show().catch((error: unknown) => {
      const message = messageOf(error);
      note(`código de pareamento: ${message}`);
      dialog.showErrorBox('Nanachi', `Não foi possível gerar o código de pareamento.\n\n${message}`);
    });
  }

  function refreshTray(status: DaemonStatus): void {
    tray.update({ status, autostart: autostart.get(), autostartSupported: autostart.supported });
  }

  /** "Iniciar com o Windows": the value now in effect, with the tray checkbox brought in line. */
  function setAutostart(enabled: boolean): boolean {
    const effective = autostart.set(enabled);
    refreshTray(host.status());
    return effective;
  }

  function startTailscale(): Promise<TailscaleStatus> {
    settings.update({ tailscaleEnabled: true });
    return tsnet.start();
  }
  function stopTailscale(): Promise<TailscaleStatus> {
    settings.update({ tailscaleEnabled: false });
    return tsnet.stop();
  }

  const tray = createTray(
    iconPath,
    {
      openControl,
      openSessions,
      generatePairingCode: showPairingCode,
      setAutostart: (enabled) => void setAutostart(enabled),
      quit: () => app.quit(),
    },
    { status: host.status(), autostart: autostart.get(), autostartSupported: autostart.supported },
  );
  note('bandeja criada');

  let lastState = host.status().state;
  let lastRestricted = false;
  let lastPort = host.status().port;
  host.onStatus((status) => {
    if (status.port !== lastPort) {
      // config.json moved the daemon: the embedded Tailscale node proxies to the old port until it is restarted.
      lastPort = status.port;
      note(`o daemon mudou para a porta ${status.port}`);
      void tsnet.retarget().catch((error: unknown) => note(`não foi possível reapontar o Tailscale embutido: ${messageOf(error)}`));
    }
    if (status.state !== lastState) {
      lastState = status.state;
      note(`daemon ${status.state} (porta ${status.port})`);
    }
    if (status.restricted !== lastRestricted) {
      lastRestricted = status.restricted;
      if (status.restricted) note('o daemon só aceita acessos pelo Tailscale (allowedTailscaleLogins); o painel local não consegue usá-lo');
    }
    refreshTray(status);
    panel.onDaemonStatus(status);
    panel.send(EVENT_CHANNELS.status, status);
    control.send(CONTROL_EVENT_CHANNELS.daemonStatus, status);
  });
  tsnet.onStatus((status) => {
    panel.send(EVENT_CHANNELS.tailscaleStatus, status);
    control.send(CONTROL_EVENT_CHANNELS.tailscaleStatus, status);
  });

  // The PWA window's bridge: a fixed list of channels, only for the page loaded from the daemon's own origin.
  registerIpc({
    ipcMain,
    isTrustedUrl: (url) => isSameOrigin(url, daemonOrigin(host.port())),
    status: () => host.status(),
    pairingCode: () => pairing.generateCode(),
    getAutostart: () => autostart.get(),
    setAutostart,
    tailscale: {
      status: () => tsnet.status(),
      start: startTailscale,
      stop: stopTailscale,
    },
    checkForUpdate: () => checkForUpdate({ currentVersion: app.getVersion() }),
    init: () => ({ version: app.getVersion(), machine: pairing.current() }),
  });

  // The control center's API: its own channel list, only for its own local page, and the device token never leaves main.
  const tokenAccess = createTokenAccess(pairing, {
    baseUrl: () => daemonOrigin(host.port()),
    // Desktop pairs itself only with a daemon it started; a different mode, port, version or process is a different daemon.
    daemon: () => {
      const status = host.status();
      return { owned: status.mode === 'spawned', generation: `${status.mode}:${status.port}:${status.pid ?? ''}:${status.version ?? ''}` };
    },
  });
  const controlActions = createControlService({
    home,
    appVersion: app.getVersion(),
    host,
    daemon: createDaemonApi({
      baseUrl: () => daemonOrigin(host.port()),
      token: tokenAccess.token,
      refreshToken: tokenAccess.refresh,
      fetchImpl: fetch,
    }),
    roots: createRootsStore({ home, ensureConfig: (target) => void ensureDesktopConfig(target) }),
    drives: createDriveLister({
      run: (command, args, options) => runProcess(command, args, { cwd: options.cwd, env: process.env }, options.timeoutMs),
      statfs: (path) => statfs(path),
    }),
    tailscale: { status: () => tsnet.status(), start: startTailscale, stop: stopTailscale },
    pairingCode: () => pairing.generateCode(),
    readLogs: () => readDesktopLogs(logFile),
    autostart: { supported: autostart.supported, get: () => autostart.get(), set: setAutostart },
    checkForUpdate: () => checkForUpdate({ currentVersion: app.getVersion() }),
    system: {
      pickFolders: () => control.pickFolders(),
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => shell.showItemInFolder(path),
      openExternal: (url) => shell.openExternal(url),
      openSessions,
      startUninstaller: () => {
        if (!app.isPackaged) {
          dialog.showErrorBox('Nanachi', 'O desinstalador só existe no Nanachi instalado.');
          return;
        }
        launchUninstaller({
          execPath: process.execPath,
          onError: (message) => {
            note(message);
            dialog.showErrorBox('Nanachi', message);
          },
        });
      },
    },
    log: note,
  });
  registerControlIpc({
    ipcMain,
    isOwnSender: (event) => control.isOwnSender(event),
    version: app.getVersion(),
    window: control,
    actions: controlActions,
  });

  // A 401 from the daemon in the panel means the device was revoked: pair again once and reload the page.
  session.defaultSession.webRequest.onCompleted((details) => {
    if (details.statusCode !== 401 || !isSameOrigin(details.url, daemonOrigin(host.port()))) return;
    if (new URL(details.url).pathname === '/api/pair') return;
    void pairing.recoverFromUnauthorized().then(
      (machine) => {
        if (machine === null) return;
        note('dispositivo revogado: Desktop pareou de novo');
        panel.reload();
      },
      (error: unknown) => note(`não foi possível parear de novo: ${messageOf(error)}`),
    );
  });

  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    // From here the control center really closes instead of hiding.
    control.destroy();
    pairingWindow.close();
    // Stops only a daemon Desktop spawned; an attached one is left running.
    void Promise.allSettled([host.stop(), tsnet.dispose()]).finally(() => {
      tray.destroy();
      app.exit(0);
    });
  });

  await host.start();
  if (settings.get().tailscaleEnabled) void tsnet.start();
  if (!startHidden) openControl();

  if (app.isPackaged) void notifyIfUpdateAvailable();
}

/** On start: one anonymous check; a newer release is announced once, and a click opens its page in the browser. */
async function notifyIfUpdateAvailable(): Promise<void> {
  const result = await checkForUpdate({ currentVersion: app.getVersion() });
  if (result.status !== 'available') return;
  const notification = new Notification({
    title: 'Nova versão do Nanachi',
    body: `A versão ${result.latest} está disponível. Clique para abrir a página da versão.`,
  });
  notification.on('click', () => void shell.openExternal(result.url));
  notification.show();
}
