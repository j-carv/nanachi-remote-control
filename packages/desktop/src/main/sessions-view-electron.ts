import { nativeTheme, session, shell, WebContentsView, type WebContents } from 'electron';
import {
  backgroundColor,
  decideWindowOpen,
  isPermissionAllowed,
  isSessionMicrophoneAllowed,
  panelWebPreferences,
  shouldAllowNavigation,
} from './panel-policy.js';
import type { ViewHandle } from './sessions-view.js';

export interface ElectronViewOptions {
  /** `dist/preload/index.cjs`: the `nanachiDesktop` bridge of the PWA, never the control API. */
  preloadPath: string;
  /** `http://127.0.0.1:<port>`, read each time because the port can change between starts. */
  origin(): string;
}

let permissionsReady = false;

/** The Electron view behind each handle, for the host that attaches it to the control window. */
const natives = new WeakMap<ViewHandle, WebContentsView>();
const sessionContents = new WeakSet<WebContents>();

/** The `WebContentsView` of a handle made by `createElectronView`. */
export function nativeViewOf(handle: ViewHandle): WebContentsView {
  const view = natives.get(handle);
  if (view === undefined) throw new TypeError('a vista das sessões não é do Electron');
  return view;
}

/**
 * The PWA runs in the default session. The microphone is available to the sessions view's own main frame.
 * The control center page has its own partition and never shares it.
 */
function setUpPermissions(origin: () => string): void {
  if (permissionsReady) return;
  permissionsReady = true;
  const target = session.defaultSession;
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'media') {
      const types = 'mediaTypes' in details ? details.mediaTypes ?? [] : [];
      callback(isSessionMicrophoneAllowed(contents !== null && sessionContents.has(contents), details.isMainFrame,
        types, details.requestingUrl, origin()));
      return;
    }
    callback(isPermissionAllowed(permission, details.requestingUrl, origin()));
  });
  target.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (permission === 'media') {
      return isSessionMicrophoneAllowed(contents !== null && sessionContents.has(contents), details.isMainFrame,
        details.mediaType === undefined ? [] : [details.mediaType], requestingOrigin, origin());
    }
    return isPermissionAllowed(permission, requestingOrigin, origin());
  });
}

/**
 * Builds the view that shows the PWA: the old panel's web preferences (sandboxed, context isolated, no Node), its session
 * and its preload. Anything the page starts stays on the daemon origin; other sites open in the default browser; no new
 * window is ever created. It starts hidden and is placed by `sessions-view.ts`.
 */
export function createElectronView(options: ElectronViewOptions): ViewHandle {
  setUpPermissions(options.origin);
  const view = new WebContentsView({ webPreferences: panelWebPreferences(options.preloadPath) });
  const contents = view.webContents;
  sessionContents.add(contents);
  view.setVisible(false);
  // No white flash in dark mode, and the other way round.
  view.setBackgroundColor(backgroundColor(nativeTheme.shouldUseDarkColors));
  const followTheme = (): void => {
    if (!contents.isDestroyed()) view.setBackgroundColor(backgroundColor(nativeTheme.shouldUseDarkColors));
  };
  nativeTheme.on('updated', followTheme);

  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideWindowOpen(url, options.origin());
    if (decision.openExternally !== null) void shell.openExternal(decision.openExternally);
    return { action: decision.action };
  });
  // Pages this view loads itself do not go through will-navigate; anything the page starts must stay on the origin.
  contents.on('will-navigate', (event, url) => {
    if (!shouldAllowNavigation(url, options.origin())) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());

  const handle: ViewHandle = {
    contents: {
      loadURL: (url) => contents.loadURL(url),
      reload: () => contents.reload(),
      isDestroyed: () => contents.isDestroyed(),
      isLoading: () => contents.isLoading(),
      getURL: () => contents.getURL(),
      send: (channel, payload) => contents.send(channel, payload),
      focus: () => {
        if (!contents.isDestroyed()) contents.focus();
      },
    },
    setBounds: (bounds) => view.setBounds(bounds),
    setVisible: (visible) => view.setVisible(visible),
    onRenderGone: (listener) => {
      contents.on('render-process-gone', (_event, details) => {
        if (details.reason !== 'clean-exit') listener(details.reason);
      });
    },
    onInput: (listener) => {
      contents.on('before-input-event', (event, input) => {
        listener(input, () => event.preventDefault());
      });
    },
    dispose: () => {
      nativeTheme.off('updated', followTheme);
      view.setVisible(false);
      // A child view that is only removed keeps its page alive: it has to be closed as well.
      if (!contents.isDestroyed()) contents.close();
    },
  };
  natives.set(handle, view);
  return handle;
}

/**
 * Clears the service workers and Cache Storage of one origin in the PWA's session, so the next load is the build on disk and not
 * a copy its service worker precached. Local storage, IndexedDB and cookies of that origin are kept: they hold the pairing token
 * and the app's state.
 */
export async function clearPwaCache(origin: string): Promise<void> {
  await session.defaultSession.clearStorageData({ origin, storages: ['serviceworkers', 'cachestorage'] });
}
