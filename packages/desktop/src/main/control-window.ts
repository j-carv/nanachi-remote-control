import { existsSync } from 'node:fs';
import { BrowserWindow, dialog, nativeTheme, type OpenDialogOptions, screen, session } from 'electron';
import { ALLOWED_CONTROL_EVENT_CHANNELS, CONTROL_EVENT_CHANNELS } from '../common/channels.js';
import type { WindowState } from '../common/control-api.js';
import type { ControlIpcSender, ControlWindowActions } from './control-ipc.js';
import {
  CONTROL_PARTITION,
  CONTROL_WINDOW_SIZE,
  controlBackgroundColor,
  controlWebPreferences,
  initialBounds,
  isControlCaller,
  isControlPermissionAllowed,
  isLocalControlUrl,
} from './control-policy.js';
import type { ControlWindowBounds } from './settings.js';

export interface ControlWindowDeps {
  /** `dist/control/index.html`, produced by the renderer build. */
  indexPath: string;
  /** `dist/preload/control.cjs`. */
  preloadPath: string;
  iconPath: string;
  /** Where the window was last time, kept in Desktop's settings. */
  bounds: {
    load(): ControlWindowBounds | undefined;
    save(bounds: ControlWindowBounds): void;
  };
  /** The page is not on disk (the renderer was not built): called instead of opening a window. */
  onMissingUi(): void;
  note(text: string): void;
  /** Replaces the disk lookup of `indexPath`; tests only. */
  exists?(path: string): boolean;
}

export interface ControlWindow extends ControlWindowActions {
  /** Opens the window, or brings the existing one (even a hidden or minimized one) to the front. */
  open(): void;
  /** Sends an event to the page; dropped unless the window shows its own local page. */
  send(channel: string, payload: unknown): void;
  /** True for a message from the control window's own page (see `isControlCaller`). */
  isOwnSender(event: ControlIpcSender): boolean;
  /** The native multi-select folder picker, parented to the control window. */
  pickFolders(): Promise<string[]>;
  /** Desktop is quitting: from now on the window really closes instead of hiding. */
  destroy(): void;
}

const PERSIST_DELAY_MS = 500;

/**
 * The control center: the main window of Nanachi Desktop. Frameless (the page draws its own title bar and the three
 * window buttons), sandboxed, context isolated, loaded from a local file, with its own storage partition. It cannot
 * navigate or open windows. Closing it hides it (Desktop keeps running in the tray); only `destroy()` ends it.
 */
export function createControlWindow(deps: ControlWindowDeps): ControlWindow {
  const exists = deps.exists ?? existsSync;
  let window: BrowserWindow | null = null;
  let quitting = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionReady = false;
  /** The page's renderer process ended abnormally: it needs a reload before the window is shown again. */
  let rendererGone = false;

  function alive(): BrowserWindow | null {
    return window !== null && !window.isDestroyed() ? window : null;
  }

  function state(): WindowState {
    const target = alive();
    return { maximized: target?.isMaximized() ?? false, focused: target?.isFocused() ?? false };
  }

  function send(channel: string, payload: unknown): void {
    const target = alive();
    if (target === null || !ALLOWED_CONTROL_EVENT_CHANNELS.has(channel)) return;
    if (target.webContents.isDestroyed() || !isLocalControlUrl(target.webContents.getURL(), deps.indexPath)) return;
    target.webContents.send(channel, payload);
  }

  function emitState(): void {
    send(CONTROL_EVENT_CHANNELS.windowState, state());
  }

  function persist(): void {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const target = alive();
    // A minimized window is not worth remembering: Windows then reports a maximized window as not maximized, and the
    // bounds it reports are the parked ones. The next move, resize or maximize while it is on screen saves it.
    if (target === null || target.isFullScreen() || target.isMinimized()) return;
    // The size and place of the normal window, also while it is maximized.
    const { x, y, width, height } = target.getNormalBounds();
    try {
      deps.bounds.save({ x, y, width, height, maximized: target.isMaximized() });
    } catch (error) {
      deps.note(`não foi possível guardar a posição da janela: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function schedulePersist(): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, PERSIST_DELAY_MS);
  }

  /** The only permission the page gets is the clipboard, and only from its own page. */
  function setUpSession(): void {
    if (sessionReady) return;
    sessionReady = true;
    const controlSession = session.fromPartition(CONTROL_PARTITION);
    const decide = (permission: string, requestingUrl: string, kind: 'pedida' | 'verificada'): boolean => {
      const allowed = isControlPermissionAllowed(permission, requestingUrl, deps.indexPath);
      if (!allowed) deps.note(`permissão ${kind} pela janela do Nanachi e recusada: ${permission}`);
      return allowed;
    };
    controlSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(decide(permission, details.requestingUrl, 'pedida'));
    });
    controlSession.setPermissionCheckHandler((_contents, permission, _origin, details) =>
      decide(permission, details.requestingUrl ?? '', 'verificada'),
    );
  }

  function create(): BrowserWindow {
    setUpSession();
    const initial = initialBounds(deps.bounds.load(), screen.getAllDisplays().map((display) => display.workArea));
    const created = new BrowserWindow({
      ...(initial.x !== undefined && initial.y !== undefined ? { x: initial.x, y: initial.y } : {}),
      width: initial.width,
      height: initial.height,
      minWidth: CONTROL_WINDOW_SIZE.minWidth,
      minHeight: CONTROL_WINDOW_SIZE.minHeight,
      frame: false,
      show: false,
      title: 'Nanachi',
      icon: deps.iconPath,
      backgroundColor: controlBackgroundColor(nativeTheme.shouldUseDarkColors),
      webPreferences: controlWebPreferences(deps.preloadPath),
    });
    created.removeMenu();

    // A single page that never navigates: anything it starts to load or open is dropped.
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    created.webContents.on('will-navigate', (event) => event.preventDefault());
    created.webContents.on('will-redirect', (event) => event.preventDefault());
    created.webContents.on('will-attach-webview', (event) => event.preventDefault());
    // A page that died stays dead until it is loaded again. It is not reloaded here (one that dies at once would loop);
    // the next `open()` (the tray, a second launch) brings it back.
    rendererGone = false;
    created.webContents.on('render-process-gone', (_event, details) => {
      deps.note(`a janela do Nanachi parou (${details.reason})`);
      if (details.reason !== 'clean-exit') rendererGone = true;
    });

    created.once('ready-to-show', () => {
      if (initial.maximized) created.maximize();
      created.show();
      emitState();
    });
    // The page shows the maximize/restore icon and the focused look from these events. A maximize or restore also
    // changes what is worth remembering.
    const stateChanged = (): void => emitState();
    const sizeChanged = (): void => {
      emitState();
      persist();
    };
    created.on('maximize', sizeChanged);
    created.on('unmaximize', sizeChanged);
    created.on('restore', stateChanged);
    created.on('focus', stateChanged);
    created.on('blur', stateChanged);
    created.on('resize', schedulePersist);
    created.on('move', schedulePersist);
    created.on('close', (event) => {
      persist();
      if (quitting) return;
      event.preventDefault();
      created.hide();
    });
    // Windows is logging off or shutting down (no `before-quit` then): a window that refuses to close would hold that up.
    created.on('session-end', () => {
      quitting = true;
    });
    // The background follows the system theme, so there is no white flash in dark mode and the other way round.
    const follow = (): void => {
      if (!created.isDestroyed()) created.setBackgroundColor(controlBackgroundColor(nativeTheme.shouldUseDarkColors));
    };
    nativeTheme.on('updated', follow);
    created.on('closed', () => {
      nativeTheme.off('updated', follow);
      if (window === created) window = null;
    });

    created.loadFile(deps.indexPath).catch((error: unknown) => {
      deps.note(`não foi possível carregar a interface do centro de controle: ${error instanceof Error ? error.message : String(error)}`);
    });
    window = created;
    return created;
  }

  return {
    open() {
      // Desktop is shutting down (a second launch can still arrive meanwhile): no new window.
      if (quitting) return;
      if (!exists(deps.indexPath)) {
        deps.note(
          `a interface do centro de controle não foi encontrada (${deps.indexPath}); rode "npm run build:desktop -w @nanachi/desktop". Abrindo as sessões no lugar.`,
        );
        deps.onMissingUi();
        return;
      }
      const existing = alive();
      if (existing === null) {
        create();
        return;
      }
      if (rendererGone) {
        rendererGone = false;
        existing.webContents.reload();
      }
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    },
    send,
    isOwnSender(event) {
      const target = alive();
      return isControlCaller(event, target === null ? null : target.webContents.id, deps.indexPath);
    },
    async pickFolders() {
      const options: OpenDialogOptions = {
        title: 'Escolher pastas permitidas',
        buttonLabel: 'Adicionar',
        properties: ['openDirectory', 'multiSelections'],
      };
      const parent = alive();
      const result = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
      return result.canceled ? [] : result.filePaths;
    },
    minimize() {
      alive()?.minimize();
    },
    toggleMaximize() {
      const target = alive();
      if (target === null) return state();
      const wasMaximized = target.isMaximized();
      if (wasMaximized) target.unmaximize();
      else target.maximize();
      // The page also gets the `maximize` / `unmaximize` event once the window has changed.
      return { maximized: !wasMaximized, focused: target.isFocused() };
    },
    close() {
      alive()?.close();
    },
    state,
    destroy() {
      quitting = true;
      persist();
      alive()?.destroy();
      window = null;
    },
  };
}
