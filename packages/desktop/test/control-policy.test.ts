import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PWA_WIDE_MIN_HEIGHT, PWA_WIDE_MIN_WIDTH, SIDEBAR_RAIL_WIDTH } from '../src/common/sessions-layout.js';
import {
  CONTROL_PARTITION,
  CONTROL_WINDOW_SIZE,
  controlBackgroundColor,
  controlWebPreferences,
  initialBounds,
  TITLE_BAR_HEIGHT,
  isAllowedLoginUrl,
  isAllowedReleaseUrl,
  isControlCaller,
  isControlPermissionAllowed,
  isLocalControlUrl,
  type Rect,
} from '../src/main/control-policy.js';

const INDEX = join('C:\\', 'Users', 'user', 'OneDrive', 'Área de Trabalho', 'Nanachi-Remote', 'packages', 'desktop', 'dist', 'control', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;

describe('isLocalControlUrl', () => {
  it('accepts the control center page, with a hash or query', () => {
    expect(isLocalControlUrl(INDEX_URL, INDEX)).toBe(true);
    expect(isLocalControlUrl(`${INDEX_URL}#/folders`, INDEX)).toBe(true);
    expect(isLocalControlUrl(`${INDEX_URL}?x=1`, INDEX)).toBe(true);
  });

  it('accepts the percent-encoding Chromium may report for accents and spaces, in either spelling', () => {
    expect(INDEX_URL).toContain('%20');
    const raw = INDEX_URL.replaceAll('%20', ' ').replace('%C3%81', 'Á');
    expect(isLocalControlUrl(raw, INDEX)).toBe(true);
  });

  it.each([
    ['another local file', pathToFileURL(join('C:\\', 'Users', 'user', 'outra.html')).href],
    ['a sibling of the page', INDEX_URL.replace('index.html', 'index.html.evil')],
    ['a page in another folder with the same name', INDEX_URL.replace('/control/', '/outro/')],
    ['the daemon origin', 'http://127.0.0.1:7780/'],
    ['a remote page', 'https://evil.example/index.html'],
    ['a data URL', 'data:text/html,<p>oi</p>'],
    ['about:blank', 'about:blank'],
    ['nothing', undefined],
    ['an empty string', ''],
    ['text that is not a URL', 'not a url'],
    ['a malformed escape', INDEX_URL.replace('index.html', 'index%E0%A4%A.html')],
  ])('refuses %s', (_label, url) => {
    expect(isLocalControlUrl(url, INDEX)).toBe(false);
  });

  it('ignores the case of the path (Windows)', () => {
    if (process.platform !== 'win32') return;
    expect(isLocalControlUrl(INDEX_URL.toUpperCase().replace('FILE:', 'file:'), INDEX)).toBe(true);
  });
});

describe('isControlCaller', () => {
  const main = { sender: { id: 7 }, senderFrame: { url: INDEX_URL, parent: null } };

  it('accepts the main frame of the control window showing its own page', () => {
    expect(isControlCaller(main, 7, INDEX)).toBe(true);
    expect(isControlCaller({ sender: { id: 7 }, senderFrame: { url: INDEX_URL } }, 7, INDEX)).toBe(true);
  });

  it('refuses when there is no control window', () => {
    expect(isControlCaller(main, null, INDEX)).toBe(false);
  });

  it('refuses another window, even one showing the same page (the panel, the installer)', () => {
    expect(isControlCaller({ ...main, sender: { id: 8 } }, 7, INDEX)).toBe(false);
  });

  it('refuses a subframe, even a local one', () => {
    expect(isControlCaller({ sender: { id: 7 }, senderFrame: { url: INDEX_URL, parent: {} } }, 7, INDEX)).toBe(false);
  });

  it('refuses a frame that is gone or not on the page', () => {
    expect(isControlCaller({ sender: { id: 7 }, senderFrame: null }, 7, INDEX)).toBe(false);
    expect(isControlCaller({ sender: { id: 7 } }, 7, INDEX)).toBe(false);
    expect(isControlCaller({ sender: { id: 7 }, senderFrame: { url: 'http://127.0.0.1:7780/', parent: null } }, 7, INDEX)).toBe(false);
    expect(isControlCaller({ sender: { id: 7 }, senderFrame: { url: 'file:///C:/outra.html', parent: null } }, 7, INDEX)).toBe(false);
  });
});

describe('isAllowedLoginUrl', () => {
  it('accepts https://login.tailscale.com/... and returns the normalized address', () => {
    expect(isAllowedLoginUrl('https://login.tailscale.com/a/abc123')).toBe('https://login.tailscale.com/a/abc123');
    expect(isAllowedLoginUrl('https://LOGIN.tailscale.com/a/x?y=1')).toBe('https://login.tailscale.com/a/x?y=1');
    expect(isAllowedLoginUrl('https://login.tailscale.com')).toBe('https://login.tailscale.com/');
  });

  it.each([
    ['plain http', 'http://login.tailscale.com/a/abc'],
    ['another host', 'https://evil.example/a/abc'],
    ['a look-alike subdomain', 'https://login.tailscale.com.evil.example/a/abc'],
    ['the host in the path', 'https://evil.example/login.tailscale.com'],
    ['another tailscale host', 'https://controlplane.tailscale.com/a/abc'],
    ['credentials in the URL', 'https://user:pass@login.tailscale.com/a/abc'],
    ['an explicit port', 'https://login.tailscale.com:8443/a/abc'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a file URL', 'file:///C:/Windows/System32/calc.exe'],
    ['an empty string', ''],
    ['text that is not a URL', 'login.tailscale.com'],
    ['a very long URL', `https://login.tailscale.com/${'a'.repeat(3000)}`],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedLoginUrl(url)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    expect(isAllowedLoginUrl(undefined as never)).toBeNull();
    expect(isAllowedLoginUrl(42 as never)).toBeNull();
    expect(isAllowedLoginUrl({ href: 'https://login.tailscale.com/' } as never)).toBeNull();
  });
});

describe('isAllowedReleaseUrl', () => {
  const base = 'https://github.com/j-carv/nanachi-remote-control/releases';

  it('accepts the releases pages of this repository', () => {
    expect(isAllowedReleaseUrl(`${base}/tag/v1.2.3`)).toBe(`${base}/tag/v1.2.3`);
    expect(isAllowedReleaseUrl(base)).toBe(base);
    expect(isAllowedReleaseUrl(`${base}/latest`)).toBe(`${base}/latest`);
  });

  it.each([
    ['another repository', 'https://github.com/j-carv/outro/releases/tag/v1'],
    ['another owner', 'https://github.com/outro/nanachi-remote-control/releases/tag/v1'],
    ['a repository that only starts the same', 'https://github.com/j-carv/nanachi-remote-control-evil/releases'],
    ['the repository home', 'https://github.com/j-carv/nanachi-remote-control'],
    ['a path that climbs out', `${base}/../../../evil/releases`],
    ['plain http', 'http://github.com/j-carv/nanachi-remote-control/releases'],
    ['a look-alike host', 'https://github.com.evil.example/j-carv/nanachi-remote-control/releases'],
    ['credentials', 'https://user@github.com/j-carv/nanachi-remote-control/releases'],
    ['a download address', 'https://objects.githubusercontent.com/x/Nanachi-Setup-1.0.0.exe'],
    ['nothing useful', ''],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedReleaseUrl(url)).toBeNull();
  });
});

describe('isControlPermissionAllowed', () => {
  it('lets the control center write to the clipboard and nothing else', () => {
    expect(isControlPermissionAllowed('clipboard-sanitized-write', INDEX_URL, INDEX)).toBe(true);
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'fullscreen', 'openExternal', 'midi']) {
      expect(isControlPermissionAllowed(permission, INDEX_URL, INDEX), permission).toBe(false);
    }
  });

  it('refuses even the clipboard to any other page', () => {
    expect(isControlPermissionAllowed('clipboard-sanitized-write', 'https://evil.example/', INDEX)).toBe(false);
    expect(isControlPermissionAllowed('clipboard-sanitized-write', 'http://127.0.0.1:7780/', INDEX)).toBe(false);
  });
});

describe('window settings', () => {
  it('pins the security preferences so nobody loosens one by accident', () => {
    const prefs = controlWebPreferences('C:\\app\\dist\\preload\\control.cjs');
    expect(prefs).toMatchObject({
      preload: 'C:\\app\\dist\\preload\\control.cjs',
      partition: CONTROL_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    });
  });

  it('uses its own storage partition, apart from the panel', () => {
    expect(CONTROL_PARTITION.startsWith('persist:')).toBe(true);
  });

  it('has the sizes of the plan', () => {
    expect(CONTROL_WINDOW_SIZE).toEqual({ width: 1180, height: 760, minWidth: 980, minHeight: 620 });
  });

  it('never leaves the PWA in the sessions view narrower or shorter than the width where it switches to its wide layout', () => {
    // On Sessões the sidebar is the 64 px rail (whatever was saved) and the view fills the rest, below the title bar.
    const { minWidth, minHeight } = CONTROL_WINDOW_SIZE;
    expect(minWidth - SIDEBAR_RAIL_WIDTH).toBeGreaterThanOrEqual(PWA_WIDE_MIN_WIDTH);
    expect(minHeight - TITLE_BAR_HEIGHT).toBeGreaterThanOrEqual(PWA_WIDE_MIN_HEIGHT);
    // A margin, so a border or a scrollbar gutter does not push it under.
    expect(minWidth - SIDEBAR_RAIL_WIDTH - PWA_WIDE_MIN_WIDTH).toBeGreaterThanOrEqual(16);
    expect(SIDEBAR_RAIL_WIDTH).toBe(64);
  });

  it('uses the thresholds of the PWA layout (packages/pwa/src/wide/layout.ts)', () => {
    const source = readFileSync(new URL('../../pwa/src/wide/layout.ts', import.meta.url), 'utf8');
    expect(source).toMatch(new RegExp(`export const WIDE_MIN_WIDTH = ${PWA_WIDE_MIN_WIDTH};`));
    expect(source).toMatch(new RegExp(`export const WIDE_MIN_HEIGHT = ${PWA_WIDE_MIN_HEIGHT};`));
  });

  it('follows the theme tokens: --ui-background light oklch(0.985 0 0) and dark oklch(0.145 0 0)', () => {
    expect(controlBackgroundColor(false)).toBe('#fafafa');
    expect(controlBackgroundColor(true)).toBe('#0a0a0a');
  });
});

describe('initialBounds', () => {
  const screen: Rect = { x: 0, y: 0, width: 1920, height: 1040 };
  const second: Rect = { x: 1920, y: 0, width: 1280, height: 1000 };

  it('opens at the default size, centered by the system, when nothing was saved', () => {
    expect(initialBounds(undefined, [screen])).toEqual({ width: 1180, height: 760, maximized: false });
  });

  it('restores saved bounds that are on a screen', () => {
    const saved = { x: 100, y: 80, width: 1300, height: 800, maximized: false };
    expect(initialBounds(saved, [screen])).toEqual(saved);
  });

  it('restores the maximized flag', () => {
    expect(initialBounds({ x: 100, y: 80, width: 1300, height: 800, maximized: true }, [screen]).maximized).toBe(true);
  });

  it('restores a window that lives on the second screen, and drops the position when that screen is gone', () => {
    const saved = { x: 2000, y: 100, width: 1000, height: 700, maximized: false };
    expect(initialBounds(saved, [screen, second])).toEqual(saved);
    expect(initialBounds(saved, [screen])).toEqual({ width: 1000, height: 700, maximized: false });
  });

  it('drops a position whose title bar cannot be reached', () => {
    // Mostly off the left edge: 100 px visible is not enough to grab.
    expect(initialBounds({ x: -900, y: 50, width: 1000, height: 700, maximized: false }, [screen])).toEqual({
      width: 1000,
      height: 700,
      maximized: false,
    });
    // Title bar above the top of the screen.
    expect(initialBounds({ x: 100, y: -300, width: 1000, height: 700, maximized: false }, [screen]).x).toBeUndefined();
    // Below the bottom.
    expect(initialBounds({ x: 100, y: 1500, width: 1000, height: 700, maximized: false }, [screen]).y).toBeUndefined();
  });

  it('keeps a window that sticks out of the screen as long as its title bar is reachable', () => {
    const saved = { x: -200, y: 20, width: 1000, height: 700, maximized: false };
    expect(initialBounds(saved, [screen])).toEqual(saved);
  });

  it('never goes under the minimum size', () => {
    expect(initialBounds({ x: 10, y: 10, width: 300, height: 200, maximized: false }, [screen])).toEqual({
      x: 10,
      y: 10,
      width: 980,
      height: 620,
      maximized: false,
    });
  });

  it('shrinks to the work area, but not under the minimum', () => {
    const small: Rect = { x: 0, y: 0, width: 1366, height: 728 };
    expect(initialBounds(undefined, [small])).toEqual({ width: 1180, height: 728, maximized: false });
    expect(initialBounds({ x: 0, y: 0, width: 5000, height: 4000, maximized: false }, [small])).toEqual({
      x: 0,
      y: 0,
      width: 1366,
      height: 728,
      maximized: false,
    });
    const tiny: Rect = { x: 0, y: 0, width: 800, height: 560 };
    expect(initialBounds(undefined, [tiny])).toMatchObject({ width: 980, height: 620 });
  });

  it('works without any display information', () => {
    expect(initialBounds(undefined, [])).toEqual({ width: 1180, height: 760, maximized: false });
    expect(initialBounds({ x: 5, y: 5, width: 1200, height: 800, maximized: false }, []).x).toBeUndefined();
  });
});
