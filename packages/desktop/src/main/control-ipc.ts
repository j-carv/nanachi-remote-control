import { CONTROL_INVOKE_CHANNELS, CONTROL_SYNC_CHANNELS } from '../common/channels.js';
import type { ControlError, ControlResult, WindowState } from '../common/control-api.js';
import { isLanguage, t, type Language } from '../common/i18n/index.js';
import { parseTranscriptionUpdate } from '../common/transcription.js';
import type { IpcCallerLike } from '../install/sender.js';
import { controlFailure, toControlError } from './control-errors.js';
import type { ControlActions } from './control-service.js';
import { UntrustedSenderError } from './ipc.js';
import { MAX_ROOT_LENGTH, MAX_ROOTS } from './roots-config.js';
import { parseViewport } from './sessions-viewport.js';

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
  /** Desktop's language now; the page learns it from the preload handshake. */
  language(): Language;
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
  handle(c.openDataFolder, () => actions.openDataFolder());
  handle(c.sessionsViewport, (report) => {
    const viewport = parseViewport(report);
    if (viewport === null) throw new TypeError('sessionsViewport espera um retângulo e dois sinalizadores');
    return actions.sessions.setViewport(viewport);
  });

  handleResult(c.foldersGet, () => actions.folders.get());
  handle(c.foldersPick, () => actions.folders.pick());
  handleResult(c.foldersSave, (roots, restart, confirmedBusy) => {
    if (!isStringList(roots) || typeof restart !== 'boolean') return invalid(t('main.control.invalidFoldersRequest'));
    if (roots.length > MAX_ROOTS) return invalid(t('main.roots.tooMany', { max: MAX_ROOTS }));
    if (roots.some((path) => path.length > MAX_ROOT_LENGTH)) return invalid(t('main.control.oneFolderTooLong'));
    // Only a number counts as a confirmation; anything else is dropped, which means "not confirmed".
    return typeof confirmedBusy === 'number' ? actions.folders.save(roots, restart, confirmedBusy) : actions.folders.save(roots, restart);
  });
  handle(c.foldersReveal, (path) => actions.folders.reveal(stringArg(path, 'foldersReveal')));

  handleResult(c.devicesList, () => actions.devices.list());
  handleResult(c.devicesRevoke, (id) => (typeof id === 'string' ? actions.devices.revoke(id) : invalid(t('main.control.invalidId'))));
  handleResult(c.devicesPairingCode, () => actions.devices.pairingCode());

  // Anything but a boolean means "from the daemon's cache".
  handleResult(c.accountsList, (refresh) => actions.accounts.list(typeof refresh === 'boolean' ? refresh : undefined));
  handleResult(c.accountsSetActive, (agentId, accountId) =>
    typeof agentId === 'string' && typeof accountId === 'string' ? actions.accounts.setActive(agentId, accountId) : invalid(t('main.control.invalidId')),
  );

  handle(c.tailscaleStatus, () => actions.tailscale.status());
  handle(c.tailscaleStart, () => actions.tailscale.start());
  handle(c.tailscaleStop, () => actions.tailscale.stop());
  handle(c.tailscaleOpenLogin, (url) => actions.tailscale.openLogin(stringArg(url, 'tailscaleOpenLogin')));

  handle(c.logsGet, () => actions.logs.get());
  handle(c.logsOpenFolder, () => actions.logs.openFolder());

  handle(c.settingsSetLanguage, (language) => {
    if (!isLanguage(language)) throw new TypeError('setLanguage espera pt-BR, en ou es');
    return actions.settings.setLanguage(language);
  });
  handleResult(c.settingsWhisper, (action) =>
    action === 'status' || action === 'install' || action === 'remove'
      ? actions.settings.whisper(action)
      : invalid(t('main.control.invalidId')),
  );
  handleResult(c.settingsTranscriptionGet, () => actions.settings.transcriptionSettings());
  handleResult(c.settingsTranscriptionUpdate, (input) => {
    const settings = parseTranscriptionUpdate(input);
    return settings === null ? invalid(t('main.control.rejected.refused')) : actions.settings.setTranscriptionSettings(settings);
  });
  handleResult(c.settingsTranscriptionStatus, () => actions.settings.transcriptionStatus());
  handleResult(c.settingsTranscriptionModels, () => actions.settings.transcriptionModels());
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
    event.returnValue = deps.isOwnSender(event) ? { version: deps.version, language: deps.language() } : null;
  };
  ipcMain.on(CONTROL_SYNC_CHANNELS.init, onInit);

  return () => {
    for (const channel of Object.values(CONTROL_INVOKE_CHANNELS)) ipcMain.removeHandler(channel);
    ipcMain.removeListener(CONTROL_SYNC_CHANNELS.init, onInit);
  };
}
