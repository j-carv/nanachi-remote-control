import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, ipcMain, Notification, safeStorage, session, shell } from 'electron';
import { EVENT_CHANNELS } from '../common/channels.js';
import { messageOf } from '../common/message.js';
import type { DaemonStatus } from '../common/types.js';
import { APP_USER_MODEL_ID, UNINSTALL_ARG } from '../install/constants.js';
import { createAutostart, HIDDEN_ARG } from './autostart.js';
import { resolveBuildDir } from './build-dir.js';
import { DaemonHost } from './daemon-host.js';
import { missingRuntimeFile, readConfiguredPort, resolveHome, resolveRuntime } from './daemon-runtime.js';
import { registerIpc } from './ipc.js';
import { createRotatingLog } from './log-file.js';
import { createDeviceAddRunner, createPairCliRunner } from './pair-cli.js';
import { createPanel } from './panel.js';
import { daemonOrigin, isSameOrigin } from './panel-policy.js';
import { createPairing, createTokenStore, desktopDeviceName } from './pairing.js';
import { createPairingWindow } from './pairing-window.js';
import { createSettingsStore } from './settings.js';
import { fetchHealth, isPortFree, killProcessTree, spawnHidden, spawnSidecar } from './system.js';
import { createTray } from './tray.js';
import { createTsnetHost, resolveSidecarPath, tsnetHostname } from './tsnet-host.js';
import { checkForUpdate } from './updates.js';
import { runUninstaller } from './uninstall-app.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

const startHidden = process.argv.includes(HIDDEN_ARG);
let openPanelRequest: (() => void) | null = null;

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
    // Another Nanachi Desktop owns the tray; it gets a `second-instance` event and shows its panel.
    app.quit();
  } else {
    app.on('second-instance', () => openPanelRequest?.());
    // A tray app keeps running with no window open.
    app.on('window-all-closed', () => undefined);
    void app.whenReady().then(boot);
  }
}

async function boot(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..', '..', '..', '..');
  const userData = app.getPath('userData');
  const home = resolveHome(process.env);

  const runtime = resolveRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, repoRoot });
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'runtime', 'assets', 'icon-192.png')
    : join(repoRoot, 'packages', 'pwa', 'public', 'icon-192.png');
  const preloadPath = join(here, '..', 'preload', 'index.cjs');

  const log = createRotatingLog({ file: join(home, 'desktop-daemon.log'), maxBytes: MAX_LOG_BYTES });
  const note = (text: string): void => log.append(`[desktop] ${text}\n`);

  const host = new DaemonHost({
    home,
    runtime,
    readPort: () => readConfiguredPort(home),
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

  function openPanel(): void {
    panel.open().catch((error: unknown) => note(`não foi possível abrir o painel: ${messageOf(error)}`));
  }
  openPanelRequest = openPanel;

  function showPairingCode(): void {
    pairingWindow.show().catch((error: unknown) => {
      const message = messageOf(error);
      note(`código de pareamento: ${message}`);
      dialog.showErrorBox('Nanachi', `Não foi possível gerar o código de pareamento.\n\n${message}`);
    });
  }

  const tray = createTray(
    iconPath,
    {
      openPanel,
      generatePairingCode: showPairingCode,
      setAutostart: (enabled) => {
        autostart.set(enabled);
        refreshTray(host.status());
      },
      quit: () => app.quit(),
    },
    { status: host.status(), autostart: autostart.get(), autostartSupported: autostart.supported },
  );
  note('bandeja criada');

  function refreshTray(status: DaemonStatus): void {
    tray.update({ status, autostart: autostart.get(), autostartSupported: autostart.supported });
  }

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
  });
  tsnet.onStatus((status) => panel.send(EVENT_CHANNELS.tailscaleStatus, status));

  registerIpc({
    ipcMain,
    isTrustedUrl: (url) => isSameOrigin(url, daemonOrigin(host.port())),
    status: () => host.status(),
    pairingCode: () => pairing.generateCode(),
    getAutostart: () => autostart.get(),
    setAutostart: (enabled) => {
      const effective = autostart.set(enabled);
      refreshTray(host.status());
      return effective;
    },
    tailscale: {
      status: () => tsnet.status(),
      start: () => {
        settings.update({ tailscaleEnabled: true });
        return tsnet.start();
      },
      stop: () => {
        settings.update({ tailscaleEnabled: false });
        return tsnet.stop();
      },
    },
    checkForUpdate: () => checkForUpdate({ currentVersion: app.getVersion() }),
    init: () => ({ version: app.getVersion(), machine: pairing.current() }),
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
    pairingWindow.close();
    // Stops only a daemon Desktop spawned; an attached one is left running.
    void Promise.allSettled([host.stop(), tsnet.dispose()]).finally(() => {
      tray.destroy();
      app.exit(0);
    });
  });

  await host.start();
  if (settings.get().tailscaleEnabled) void tsnet.start();
  if (!startHidden) openPanel();

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
