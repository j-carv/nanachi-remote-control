import { describe, expect, it } from 'vitest';
import {
  backgroundColor,
  daemonOrigin,
  decideWindowOpen,
  isPermissionAllowed,
  isSessionMicrophoneAllowed,
  isSameOrigin,
  panelWebPreferences,
  shouldAllowNavigation,
} from '../src/main/panel-policy.js';
import { createAutostart, HIDDEN_ARG, type LoginItemApi } from '../src/main/autostart.js';

const ORIGIN = daemonOrigin(7811);

describe('panel navigation policy', () => {
  it('builds the loopback origin from the port', () => {
    expect(ORIGIN).toBe('http://127.0.0.1:7811');
  });

  it('allows pages of the daemon origin, nothing else', () => {
    expect(shouldAllowNavigation('http://127.0.0.1:7811/', ORIGIN)).toBe(true);
    expect(shouldAllowNavigation('http://127.0.0.1:7811/workspaces?x=1#a', ORIGIN)).toBe(true);
    expect(shouldAllowNavigation('http://127.0.0.1:7777/', ORIGIN)).toBe(false);
    expect(shouldAllowNavigation('http://localhost:7811/', ORIGIN)).toBe(false);
    expect(shouldAllowNavigation('https://127.0.0.1:7811/', ORIGIN)).toBe(false);
    expect(shouldAllowNavigation('https://example.com/', ORIGIN)).toBe(false);
    expect(shouldAllowNavigation('file:///C:/Windows/win.ini', ORIGIN)).toBe(false);
    expect(shouldAllowNavigation('javascript:alert(1)', ORIGIN)).toBe(false);
    expect(shouldAllowNavigation('data:text/html,<h1>x</h1>', ORIGIN)).toBe(false);
    expect(shouldAllowNavigation('not a url', ORIGIN)).toBe(false);
    // A look-alike host that merely starts with the origin text.
    expect(shouldAllowNavigation('http://127.0.0.1:7811.evil.example/', ORIGIN)).toBe(false);
    expect(shouldAllowNavigation('http://127.0.0.1:7811@evil.example/', ORIGIN)).toBe(false);
  });

  it('isSameOrigin handles missing input', () => {
    expect(isSameOrigin(undefined, ORIGIN)).toBe(false);
    expect(isSameOrigin('', ORIGIN)).toBe(false);
  });
});

describe('window.open and target=_blank', () => {
  it('never opens a window; other sites go to the default browser', () => {
    expect(decideWindowOpen('https://github.com/j-carv/nanachi-remote-control', ORIGIN)).toEqual({
      action: 'deny',
      openExternally: 'https://github.com/j-carv/nanachi-remote-control',
    });
    expect(decideWindowOpen('http://example.com/a', ORIGIN)).toEqual({ action: 'deny', openExternally: 'http://example.com/a' });
  });

  it('drops the daemon itself and every non-http(s) scheme', () => {
    for (const url of [
      'http://127.0.0.1:7811/popup',
      'file:///C:/x',
      'javascript:alert(1)',
      'data:text/html,hi',
      'mailto:a@b.c',
      'ms-settings:privacy',
      'chrome://gpu',
      'garbage',
    ]) {
      expect(decideWindowOpen(url, ORIGIN)).toEqual({ action: 'deny', openExternally: null });
    }
  });
});

describe('permissions', () => {
  it('allows audio capture only in the main frame of the local sessions view', () => {
    expect(isSessionMicrophoneAllowed(true, true, ['audio'], `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isSessionMicrophoneAllowed(false, true, ['audio'], ORIGIN, ORIGIN)).toBe(false);
    expect(isSessionMicrophoneAllowed(true, false, ['audio'], ORIGIN, ORIGIN)).toBe(false);
    expect(isSessionMicrophoneAllowed(true, true, ['video'], ORIGIN, ORIGIN)).toBe(false);
    expect(isSessionMicrophoneAllowed(true, true, ['audio', 'video'], ORIGIN, ORIGIN)).toBe(false);
    expect(isSessionMicrophoneAllowed(true, true, ['audio'], 'https://other.example/', ORIGIN)).toBe(false);
  });
  it('allows clipboard write and fullscreen for the daemon origin only', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isPermissionAllowed('fullscreen', `${ORIGIN}/`, ORIGIN)).toBe(true);
    expect(isPermissionAllowed('clipboard-sanitized-write', 'https://evil.example/', ORIGIN)).toBe(false);
    for (const permission of ['media', 'geolocation', 'notifications', 'openExternal', 'clipboard-read', 'hid', 'usb']) {
      expect(isPermissionAllowed(permission, `${ORIGIN}/`, ORIGIN)).toBe(false);
    }
  });
});

describe('window settings', () => {
  it('pins the security preferences from the contract', () => {
    expect(panelWebPreferences('C:\\app\\preload.cjs')).toEqual({
      preload: 'C:\\app\\preload.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it('uses the theme background', () => {
    expect(backgroundColor(true)).not.toBe(backgroundColor(false));
  });
});

describe('autostart', () => {
  function fakeApi(): LoginItemApi & { current: boolean; calls: unknown[] } {
    const api = {
      current: false,
      calls: [] as unknown[],
      setLoginItemSettings(settings: { openAtLogin: boolean; args: string[] }) {
        api.calls.push(settings);
        api.current = settings.openAtLogin;
      },
      getLoginItemSettings: () => ({ openAtLogin: api.current }),
    };
    return api;
  }

  it('registers the login item with --hidden when packaged', () => {
    const api = fakeApi();
    const autostart = createAutostart(api, true);
    expect(autostart.supported).toBe(true);
    expect(autostart.get()).toBe(false);
    expect(autostart.set(true)).toBe(true);
    expect(api.calls).toEqual([{ openAtLogin: true, args: [HIDDEN_ARG] }]);
    expect(autostart.set(false)).toBe(false);
  });

  it('never touches the login items in development', () => {
    const api = fakeApi();
    const autostart = createAutostart(api, false);
    expect(autostart.supported).toBe(false);
    expect(autostart.get()).toBe(false);
    expect(autostart.set(true)).toBe(false);
    expect(api.calls).toEqual([]);
  });
});
