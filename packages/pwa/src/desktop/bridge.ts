import type { DaemonStatus, PairingCode, TailscaleStatus, UpdateCheckResult } from './schema.js';

/**
 * `window.nanachiDesktop`, exposed by the preload of Nanachi Desktop (Electron). It exists only inside that app; in a
 * browser or on the phone it is undefined and the Desktop group of Settings is not rendered. This is the PWA's own
 * copy of the contract (`packages/desktop/src/common/types.ts`): there is no Electron import here.
 *
 * Answers are `unknown` in practice: every consumer runs them through the parsers in `schema.ts`.
 */
export interface NanachiDesktopBridge {
  readonly version: string;
  status(): Promise<DaemonStatus>;
  onStatus(callback: (status: DaemonStatus) => void): () => void;
  /**
   * Desktop's language changed in its control center. Missing from a Desktop older than this event, so the guard below does
   * not require it; the value is checked by `followDesktopLanguage`.
   */
  onLanguage?(callback: (language: unknown) => void): () => void;
  pairingCode(): Promise<PairingCode>;
  getAutostart(): Promise<boolean>;
  setAutostart(value: boolean): Promise<boolean>;
  checkForUpdate(): Promise<UpdateCheckResult>;
  readonly tailscale: {
    status(): Promise<TailscaleStatus>;
    start(): Promise<TailscaleStatus>;
    stop(): Promise<TailscaleStatus>;
    onStatus(callback: (status: TailscaleStatus) => void): () => void;
  };
}

declare global {
  interface Window {
    nanachiDesktop?: NanachiDesktopBridge;
  }
}

function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

/** True when `value` has the shape of the bridge. A page that only claims the name does not get a Desktop section. */
export function isDesktopBridge(value: unknown): value is NanachiDesktopBridge {
  if (typeof value !== 'object' || value === null) return false;
  const bridge = value as Record<string, unknown>;
  if (typeof bridge.version !== 'string') return false;
  const methods = ['status', 'onStatus', 'pairingCode', 'getAutostart', 'setAutostart', 'checkForUpdate'];
  if (!methods.every((name) => isFunction(bridge[name]))) return false;
  const tailscale = bridge.tailscale;
  if (typeof tailscale !== 'object' || tailscale === null) return false;
  const tailscaleApi = tailscale as Record<string, unknown>;
  return ['status', 'start', 'stop', 'onStatus'].every((name) => isFunction(tailscaleApi[name]));
}

/** The bridge when running inside Nanachi Desktop, else null. `source` is `window` (a parameter for tests). */
export function getDesktopBridge(
  source: { nanachiDesktop?: unknown } | undefined = typeof window === 'undefined' ? undefined : window,
): NanachiDesktopBridge | null {
  const candidate = source?.nanachiDesktop;
  return isDesktopBridge(candidate) ? candidate : null;
}
