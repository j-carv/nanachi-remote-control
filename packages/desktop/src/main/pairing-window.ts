import { randomBytes } from 'node:crypto';
import { BrowserWindow, nativeTheme } from 'electron';
import QRCode from 'qrcode';
import { t } from '../common/i18n/index.js';
import { pairingLink, phoneOrigin } from '../common/pairing-link.js';
import type { PairingCode, TailscaleStatus } from '../common/types.js';
import { backgroundColor } from './panel-policy.js';
import { pngDataUrl, renderPairingHtml, toDataUrl } from './pages.js';

export interface PairingWindowDeps {
  /** A fresh code from the daemon CLI. */
  generate(): Promise<PairingCode>;
  tailscaleStatus(): TailscaleStatus;
  iconPath: string;
}

export interface PairingWindow {
  /** Opens (or refreshes) the small always-on-top window with a new code. Rejects when no code could be made. */
  show(): Promise<void>;
  close(): void;
}

/** The phone's pairing link as a high-contrast QR image. */
export function qrDataUrl(link: string): Promise<string> {
  return QRCode.toDataURL(link, { margin: 4, width: 184, errorCorrectionLevel: 'M', color: { dark: '#000000ff', light: '#ffffffff' } });
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
      const link = pairingLink(phoneOrigin(deps.tailscaleStatus()) ?? pairing.externalOrigin ?? null, pairing.code);
      const html = renderPairingHtml({
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        qrDataUrl: link === null ? undefined : await qrDataUrl(link),
        // The same icon as the window's own (`iconPath`: the PWA's 192 px icon in development, the staged copy when packaged).
        logoDataUrl: pngDataUrl(deps.iconPath),
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
