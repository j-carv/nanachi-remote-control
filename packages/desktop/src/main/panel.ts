import { BrowserWindow, nativeTheme, session, shell } from 'electron';
import type { DaemonStatus } from '../common/types.js';
import { renderStatusPageHtml, toDataUrl } from './pages.js';
import {
  backgroundColor,
  decideWindowOpen,
  isPermissionAllowed,
  isSameOrigin,
  PANEL_SIZE,
  panelWebPreferences,
  shouldAllowNavigation,
} from './panel-policy.js';

export interface PanelDeps {
  /** `http://127.0.0.1:<port>`, read each time because the port can change between starts. */
  origin(): string;
  daemonStatus(): DaemonStatus;
  preloadPath: string;
  iconPath: string;
  /** Pairs Desktop with the daemon when needed, before the PWA loads. A failure only means the PWA starts unpaired. */
  prepare(): Promise<void>;
}

export interface Panel {
  /** Opens the window, or brings the existing one to the front. */
  open(): Promise<void>;
  /** Tells the panel the daemon status changed: it swaps the "not ready" page for the PWA when the daemon is up. */
  onDaemonStatus(status: DaemonStatus): void;
  /** Sends an event to the page (channel must be one of the fixed event channels). */
  send(channel: string, payload: unknown): void;
  /** Reloads the PWA, e.g. after Desktop paired again so the preload seeds the new token. */
  reload(): void;
  isOpen(): boolean;
  close(): void;
}

/** The PWA can be loaded: a daemon is up and it accepts calls from this PC. */
function isReady(status: DaemonStatus): boolean {
  return (status.state === 'running' || status.state === 'attached') && !status.restricted;
}

/**
 * The panel is the PWA itself, loaded from the local daemon in a locked-down window: no Node, sandboxed, context
 * isolated, one origin. While the daemon is not up it shows a small local page instead of a connection error.
 */
export function createPanel(deps: PanelDeps): Panel {
  let window: BrowserWindow | null = null;
  let showing: 'pwa' | 'status' | null = null;
  let permissionsReady = false;

  function alive(): BrowserWindow | null {
    return window !== null && !window.isDestroyed() ? window : null;
  }

  function setUpPermissions(): void {
    if (permissionsReady) return;
    permissionsReady = true;
    const panelSession = session.defaultSession;
    panelSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(isPermissionAllowed(permission, details.requestingUrl, deps.origin()));
    });
    panelSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      isPermissionAllowed(permission, `${requestingOrigin}/`, deps.origin()),
    );
  }

  function create(): BrowserWindow {
    setUpPermissions();
    const created = new BrowserWindow({
      ...PANEL_SIZE,
      autoHideMenuBar: true,
      show: false,
      title: 'Nanachi',
      icon: deps.iconPath,
      backgroundColor: backgroundColor(nativeTheme.shouldUseDarkColors),
      webPreferences: panelWebPreferences(deps.preloadPath),
    });
    created.removeMenu();

    created.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, deps.origin());
      if (decision.openExternally !== null) void shell.openExternal(decision.openExternally);
      return { action: decision.action };
    });
    // Pages this module loads itself do not go through will-navigate; anything the page starts must stay on the origin.
    created.webContents.on('will-navigate', (event, url) => {
      if (!shouldAllowNavigation(url, deps.origin())) event.preventDefault();
    });
    created.webContents.on('will-attach-webview', (event) => event.preventDefault());
    created.once('ready-to-show', () => created.show());
    created.on('closed', () => {
      if (window === created) {
        window = null;
        showing = null;
      }
    });
    window = created;
    return created;
  }

  async function render(target: BrowserWindow): Promise<void> {
    const status = deps.daemonStatus();
    if (!isReady(status)) {
      showing = 'status';
      await target.loadURL(toDataUrl(renderStatusPageHtml(status)));
      return;
    }
    try {
      await deps.prepare();
    } catch {
      // Not paired: the PWA still loads and offers its own pairing screen. The caller logs the reason.
    }
    if (target.isDestroyed()) return;
    showing = 'pwa';
    await target.loadURL(`${deps.origin()}/`);
  }

  return {
    async open() {
      const existing = alive();
      if (existing !== null) {
        if (existing.isMinimized()) existing.restore();
        existing.show();
        existing.focus();
        return;
      }
      await render(create());
    },
    onDaemonStatus(status) {
      const target = alive();
      if (target === null) return;
      if (isReady(status)) {
        // From the "not ready" page to the app. While the PWA is showing, leave it alone: it reports its own offline state.
        if (showing === 'status') void render(target).catch(() => undefined);
      } else if (showing === 'status') {
        void target.loadURL(toDataUrl(renderStatusPageHtml(status))).catch(() => undefined);
      }
    },
    send(channel, payload) {
      const target = alive();
      if (target === null || showing !== 'pwa') return;
      const current = target.webContents.getURL();
      if (!isSameOrigin(current, deps.origin())) return;
      target.webContents.send(channel, payload);
    },
    reload() {
      const target = alive();
      if (target !== null && showing === 'pwa') target.webContents.reload();
    },
    isOpen: () => alive() !== null,
    close() {
      alive()?.close();
    },
  };
}
