import { randomBytes } from 'node:crypto';
import { BrowserWindow, nativeTheme } from 'electron';
import QRCode from 'qrcode';
import { t } from '../common/i18n/index.js';
import type { PairingCode } from '../common/types.js';
import { backgroundColor } from './panel-policy.js';
import { renderPairingHtml, toDataUrl } from './pages.js';

export interface PairingWindowDeps {
  /** A fresh code from the daemon CLI. */
  generate(): Promise<PairingCode>;
  iconPath: string;
}

export interface PairingWindow {
  /** Opens (or refreshes) the small always-on-top window with a new code. Rejects when no code could be made. */
  show(): Promise<void>;
  close(): void;
}

/** QR of the six digits, as a PNG data URL. Black on white whatever the theme, so phone cameras read it. */
export function qrDataUrl(code: string): Promise<string> {
  return QRCode.toDataURL(code, { margin: 1, width: 184, errorCorrectionLevel: 'M', color: { dark: '#000000ff', light: '#ffffffff' } });
}

/** One small window at a time: asking again replaces the code in the same window. */
export function createPairingWindow(deps: PairingWindowDeps): PairingWindow {
  let window: BrowserWindow | null = null;

  function ensureWindow(): BrowserWindow {
    if (window !== null && !window.isDestroyed()) return window;
    const created = new BrowserWindow({
      width: 360,
      height: 560,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      autoHideMenuBar: true,
      show: false,
      title: t('main.pairingWindow.windowTitle'),
      icon: deps.iconPath,
      backgroundColor: backgroundColor(nativeTheme.shouldUseDarkColors),
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    created.removeMenu();
    created.webContents.on('will-navigate', (event) => event.preventDefault());
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    created.once('ready-to-show', () => created.show());
    created.on('closed', () => {
      if (window === created) window = null;
    });
    window = created;
    return created;
  }

  return {
    async show() {
      const pairing = await deps.generate();
      const html = renderPairingHtml({
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        qrDataUrl: await qrDataUrl(pairing.code),
        nonce: randomBytes(16).toString('base64'),
        now: Date.now(),
      });
      const target = ensureWindow();
      await target.loadURL(toDataUrl(html));
      if (target.isVisible()) target.focus();
    },
    close() {
      if (window !== null && !window.isDestroyed()) window.close();
    },
  };
}
