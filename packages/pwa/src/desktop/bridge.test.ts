import { describe, expect, it } from 'vitest';
import { getDesktopBridge, isDesktopBridge } from './bridge.js';

const noop = (): Promise<never> => new Promise(() => undefined);
const unsubscribe = (): (() => void) => () => undefined;

function fakeBridge(): Record<string, unknown> {
  return {
    version: '0.1.0',
    status: noop,
    onStatus: unsubscribe,
    pairingCode: noop,
    getAutostart: noop,
    setAutostart: noop,
    checkForUpdate: noop,
    tailscale: { status: noop, start: noop, stop: noop, onStatus: unsubscribe },
  };
}

describe('getDesktopBridge', () => {
  it('is null in a browser or on the phone: there is no window.nanachiDesktop', () => {
    expect(getDesktopBridge({})).toBeNull();
    expect(getDesktopBridge(undefined)).toBeNull();
  });

  it('is null when called with no window at all (server-side render, tests)', () => {
    expect(getDesktopBridge()).toBeNull();
  });

  it('returns the bridge that Desktop injects', () => {
    const bridge = fakeBridge();
    expect(getDesktopBridge({ nanachiDesktop: bridge })).toBe(bridge);
  });

  it('ignores a page that only claims the name', () => {
    expect(getDesktopBridge({ nanachiDesktop: true })).toBeNull();
    expect(getDesktopBridge({ nanachiDesktop: {} })).toBeNull();
    expect(getDesktopBridge({ nanachiDesktop: { version: '1' } })).toBeNull();
  });
});

describe('isDesktopBridge', () => {
  it('needs a version, the six methods and the four Tailscale methods', () => {
    expect(isDesktopBridge(fakeBridge())).toBe(true);

    for (const key of ['version', 'status', 'onStatus', 'pairingCode', 'getAutostart', 'setAutostart', 'checkForUpdate', 'tailscale']) {
      const broken = fakeBridge();
      delete broken[key];
      expect(isDesktopBridge(broken)).toBe(false);
    }
    for (const key of ['status', 'start', 'stop', 'onStatus']) {
      const broken = fakeBridge();
      broken.tailscale = { ...(broken.tailscale as Record<string, unknown>), [key]: 'not a function' };
      expect(isDesktopBridge(broken)).toBe(false);
    }
  });

  it('rejects non-objects', () => {
    expect(isDesktopBridge(null)).toBe(false);
    expect(isDesktopBridge('bridge')).toBe(false);
  });
});
