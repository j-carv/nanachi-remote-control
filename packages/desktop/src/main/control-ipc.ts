import { CONTROL_INVOKE_CHANNELS, CONTROL_SYNC_CHANNELS } from '../common/channels.js';
import type { ControlError, ControlResult, WindowState } from '../common/control-api.js';
import type { IpcCallerLike } from '../install/sender.js';
import { controlFailure, toControlError } from './control-errors.js';
import type { ControlActions } from './control-service.js';
import { UntrustedSenderError } from './ipc.js';
import { MAX_ROOT_LENGTH, MAX_ROOTS } from './roots-config.js';

/** What a handler knows about its caller: the web contents and the frame that sent the message. */
export type ControlIpcSender = IpcCallerLike;

type SyncEvent = ControlIpcSender & { returnValue: unknown };

/** The part of `ipcMain` used here. */
export interface ControlIpcMainLike {
  handle(channel: string, listener: (event: ControlIpcSender, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: SyncEvent) => void): void;
  removeListener(channel: string, listener: (event: SyncEvent) => void): void;
}

/** The window controls the title bar drives (`ControlWindow` in `control-window.ts`). */
export interface ControlWindowActions {
  minimize(): void;
  toggleMaximize(): WindowState;
  /** Hides the window; Desktop keeps running in the tray. */
  close(): void;
  state(): WindowState;
}

export interface ControlIpcDeps {
  ipcMain: ControlIpcMainLike;
  /** True only for the control window's own page (see `isControlCaller`). */
  isOwnSender(event: ControlIpcSender): boolean;
  version: string;
  window: ControlWindowActions;
  actions: ControlActions;
}

function invalid(message: string): ControlError {
  return controlFailure('invalid_input', message);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function stringArg(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} espera um texto`);
  return value;
}

/**
 * Registers the fixed control channel list. Every handler first checks that the message comes from the control window's own
 * page, then checks the shape of what the page sent (the meaning of it is checked by `control-service.ts`); extra
 * arguments are ignored. A handler that returns a `ControlResult` never rejects for an expected or unexpected failure: the
 * failure travels as a `ControlError`. The ones that return nothing throw a `TypeError` for a malformed argument.
 * Returns a function that removes everything it registered.
 */
export function registerControlIpc(deps: ControlIpcDeps): () => void {
  const { ipcMain, actions, window } = deps;
  const c = CONTROL_INVOKE_CHANNELS;

  function trusted(event: ControlIpcSender): void {
    if (!deps.isOwnSender(event)) throw new UntrustedSenderError();
  }

  /** A handler that returns plain data or nothing. */
  function handle(channel: string, run: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, (event, ...args) => {
      trusted(event);
      return run(...args);
    });
  }

  /** A handler that returns a `ControlResult`: whatever goes wrong becomes a `ControlError`. */
  function handleResult(channel: string, run: (...args: unknown[]) => ControlResult<unknown> | Promise<ControlResult<unknown>>): void {
    ipcMain.handle(channel, (event, ...args) => {
      trusted(event);
      return (async () => {
        try {
          return await run(...args);
        } catch (error) {
          return toControlError(error);
        }
      })();
    });
  }

  handle(c.windowMinimize, () => window.minimize());
  handle(c.windowToggleMaximize, () => window.toggleMaximize());
  handle(c.windowClose, () => window.close());
  handle(c.windowState, () => window.state());

  handleResult(c.overview, () => actions.overview());
  handleResult(c.restartDaemon, () => actions.restartDaemon());
  handle(c.openSessions, () => actions.openSessions());
  handle(c.openDataFolder, () => actions.openDataFolder());

  handleResult(c.foldersGet, () => actions.folders.get());
  handle(c.foldersPick, () => actions.folders.pick());
  handleResult(c.foldersSave, (roots, restart, confirmedBusy) => {
    if (!isStringList(roots) || typeof restart !== 'boolean') return invalid('Pedido inválido: a lista de pastas ou a opção de reiniciar não faz sentido.');
    if (roots.length > MAX_ROOTS) return invalid(`Muitas pastas: o máximo é ${MAX_ROOTS}.`);
    if (roots.some((path) => path.length > MAX_ROOT_LENGTH)) return invalid('Um dos caminhos é longo demais.');
    // Only a number counts as a confirmation; anything else is dropped, which means "not confirmed".
    return typeof confirmedBusy === 'number' ? actions.folders.save(roots, restart, confirmedBusy) : actions.folders.save(roots, restart);
  });
  handle(c.foldersReveal, (path) => actions.folders.reveal(stringArg(path, 'foldersReveal')));

  handleResult(c.devicesList, () => actions.devices.list());
  handleResult(c.devicesRevoke, (id) => (typeof id === 'string' ? actions.devices.revoke(id) : invalid('Identificador inválido.')));
  handleResult(c.devicesPairingCode, () => actions.devices.pairingCode());

  // Anything but a boolean means "from the daemon's cache".
  handleResult(c.accountsList, (refresh) => actions.accounts.list(typeof refresh === 'boolean' ? refresh : undefined));
  handleResult(c.accountsSetActive, (agentId, accountId) =>
    typeof agentId === 'string' && typeof accountId === 'string' ? actions.accounts.setActive(agentId, accountId) : invalid('Identificador inválido.'),
  );

  handle(c.tailscaleStatus, () => actions.tailscale.status());
  handle(c.tailscaleStart, () => actions.tailscale.start());
  handle(c.tailscaleStop, () => actions.tailscale.stop());
  handle(c.tailscaleOpenLogin, (url) => actions.tailscale.openLogin(stringArg(url, 'tailscaleOpenLogin')));

  handle(c.logsGet, () => actions.logs.get());
  handle(c.logsOpenFolder, () => actions.logs.openFolder());

  handle(c.settingsGetAutostart, () => actions.settings.getAutostart());
  handle(c.settingsSetAutostart, (value) => {
    if (typeof value !== 'boolean') throw new TypeError('setAutostart espera true ou false');
    return actions.settings.setAutostart(value);
  });
  handle(c.settingsCheckForUpdate, () => actions.settings.checkForUpdate());
  handle(c.settingsOpenUpdate, (url) => actions.settings.openUpdate(stringArg(url, 'settingsOpenUpdate')));
  handle(c.settingsUninstall, () => actions.settings.uninstall());

  // Synchronous handshake of the preload: answered from memory, and a stranger gets nothing (not even an error).
  const onInit = (event: SyncEvent): void => {
    event.returnValue = deps.isOwnSender(event) ? { version: deps.version } : null;
  };
  ipcMain.on(CONTROL_SYNC_CHANNELS.init, onInit);

  return () => {
    for (const channel of Object.values(CONTROL_INVOKE_CHANNELS)) ipcMain.removeHandler(channel);
    ipcMain.removeListener(CONTROL_SYNC_CHANNELS.init, onInit);
  };
}
