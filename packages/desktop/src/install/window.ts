import { BrowserWindow } from 'electron';

export interface ShellWindowOptions {
  width: number;
  height: number;
  title: string;
  /** Preload bundle (CommonJS: a sandboxed preload cannot load siblings). */
  preloadPath: string;
  htmlPath: string;
  iconPath: string;
  /** False for unattended runs (`--yes`): the page still loads and works, it is just not shown. */
  visible: boolean;
  onLoadError(error: Error): void;
}

/**
 * The frameless, transparent window of the installer and the uninstaller. The rounded card and its shadow are drawn by
 * the page; the window itself is a transparent rectangle a few pixels larger than the card. The page can only talk to
 * the main process through the preload bridge, and it can neither navigate nor open windows.
 */
export function createShellWindow(options: ShellWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: options.width,
    height: options.height,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: options.title,
    icon: options.iconPath,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.removeMenu();
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => {
    if (options.visible) window.show();
  });
  window.loadFile(options.htmlPath).catch((error: unknown) => {
    options.onLoadError(error instanceof Error ? error : new Error(String(error)));
  });
  return window;
}
