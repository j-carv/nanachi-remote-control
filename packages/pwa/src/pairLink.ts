/** The pairing code: exactly six digits, the same check the pairing form makes. */
export const PAIR_CODE_PATTERN = /^[0-9]{6}$/;

const PAIR_PREFIX = '#pair=';

/**
 * The code of a pair link (`<origin>/#pair=<code>`, the link the desktop app shows as a QR), or null when the hash is
 * anything else. Only the exact prefix and six digits count; every other fragment is left alone.
 */
export function parsePairFragment(hash: string): string | null {
  if (!hash.startsWith(PAIR_PREFIX)) return null;
  const code = hash.slice(PAIR_PREFIX.length);
  return PAIR_CODE_PATTERN.test(code) ? code : null;
}

/**
 * What the app does with a pair link when the page loads.
 * - `pair`: exchange the code now (outside iOS, storage is shared with the installed app; on iOS only when installed).
 * - `install-guide`: on iOS in Safari, the installed app has its own storage, so pairing here would be lost. Do not
 *   consume the code; show how to add the app to the Home Screen and keep the fragment in the URL.
 * - `ignore`: the hash is not a pair link.
 */
export type PairStartupAction = 'ignore' | 'pair' | 'install-guide';

export function pairStartupAction(hash: string, isStandalone: boolean, isIos: boolean): PairStartupAction {
  if (parsePairFragment(hash) === null) return 'ignore';
  return isIos && !isStandalone ? 'install-guide' : 'pair';
}

/** The device and page facts `pairStartupAction` needs. */
export interface PairEnvironment {
  readonly isStandalone: boolean;
  readonly isIos: boolean;
}

/** A pair link this page load starts with: the code and what to do with it (null when the URL has none). */
export interface PairLinkStart {
  readonly code: string;
  readonly action: 'pair' | 'install-guide';
}

export function pairLinkStart(hash: string, environment: PairEnvironment): PairLinkStart | null {
  const action = pairStartupAction(hash, environment.isStandalone, environment.isIos);
  const code = parsePairFragment(hash);
  if (action === 'ignore' || code === null) return null;
  return { code, action };
}

/**
 * iPhone, iPod and iPad, including iPadOS, which reports a Mac with a touch screen (`MacIntel` and more than one touch
 * point). A Mac without a touch screen is not iOS.
 */
export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

/** Running as an installed app: the display-mode query, or `navigator.standalone` on iOS. */
export function isStandaloneApp(displayStandalone: boolean, navigatorStandalone: unknown): boolean {
  return displayStandalone || navigatorStandalone === true;
}

/** Reads the environment of this page from the browser. */
export function readPairEnvironment(): PairEnvironment {
  const displayStandalone = window.matchMedia('(display-mode: standalone)').matches;
  const navigatorStandalone = 'standalone' in navigator ? navigator.standalone : undefined;
  return {
    isStandalone: isStandaloneApp(displayStandalone, navigatorStandalone),
    isIos: isIosDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
  };
}
