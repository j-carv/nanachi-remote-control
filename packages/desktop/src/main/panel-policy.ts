/** Origin of the daemon the sessions view (the PWA) talks to: `http://127.0.0.1:<port>`. */
export function daemonOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isSameOrigin(url: string | undefined, origin: string): boolean {
  if (url === undefined) return false;
  const parsed = parse(url);
  return parsed !== null && parsed.origin === origin;
}

/** The sessions view may stay on pages of the daemon origin; every other navigation is blocked. */
export function shouldAllowNavigation(url: string, origin: string): boolean {
  return isSameOrigin(url, origin);
}

export interface WindowOpenDecision {
  /** New windows are never created: the PWA lives in one view of the control center. */
  action: 'deny';
  /** An http(s) address that is not the daemon itself goes to the default browser. */
  openExternally: string | null;
}

/** `target="_blank"` and `window.open`: http(s) links to other sites open in the browser; everything else is dropped. */
export function decideWindowOpen(url: string, origin: string): WindowOpenDecision {
  const parsed = parse(url);
  const external =
    parsed !== null && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin !== origin;
  return { action: 'deny', openExternally: external ? parsed.href : null };
}

/** The few permissions the PWA may use, and only on the daemon origin. Everything else is denied. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen']);

export function isPermissionAllowed(permission: string, requestingUrl: string, origin: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && isSameOrigin(requestingUrl, origin);
}

/** Window background before the page paints, so the dark theme does not flash white. Matches `--ui-background`. */
export function backgroundColor(dark: boolean): string {
  return dark ? '#0a0a0a' : '#fafafa';
}

/** The security preferences of the sessions view (the PWA). A test pins them so nobody loosens one by accident. */
export function panelWebPreferences(preload: string): {
  preload: string;
  contextIsolation: true;
  sandbox: true;
  nodeIntegration: false;
  webSecurity: true;
  allowRunningInsecureContent: false;
} {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}
