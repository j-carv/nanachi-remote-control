import { describe, expect, it } from 'vitest';
import { isIosDevice, isStandaloneApp, pairLinkStart, pairStartupAction, parsePairFragment } from './pairLink.js';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
/** iPadOS 13+ asks for the desktop site by default, so its user agent says Macintosh. */
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

describe('parsePairFragment', () => {
  it.each([
    ['#pair=000000', '000000'],
    ['#pair=123456', '123456'],
    ['#pair=042117', '042117'],
  ])('returns the code of the pair link %s', (hash, code) => {
    expect(parsePairFragment(hash)).toBe(code);
  });

  it.each([
    ['an empty hash', ''],
    ['a bare hash mark', '#'],
    ['another fragment', '#chat'],
    ['no hash mark', 'pair=123456'],
    ['a key in capitals', '#PAIR=123456'],
    ['a misspelled key', '#pairs=123456'],
    ['five digits', '#pair=12345'],
    ['seven digits', '#pair=1234567'],
    ['an empty code', '#pair='],
    ['a letter in the code', '#pair=12a456'],
    ['letters only', '#pair=abcdef'],
    ['a space before the code', '#pair= 123456'],
    ['a space after the code', '#pair=123456 '],
    ['a trailing newline', '#pair=123456\n'],
    ['an extra parameter', '#pair=123456&x=1'],
    ['a second fragment', '#pair=123456#more'],
    ['a path after the code', '#pair=123456/'],
    ['non-ASCII digits', '#pair=\u0661\u0662\u0663\u0664\u0665\u0666'],
    ['a sign', '#pair=-12345'],
    ['a decimal point', '#pair=12.456'],
  ])('rejects %s', (_label, hash) => {
    expect(parsePairFragment(hash)).toBeNull();
  });
});

describe('pairStartupAction', () => {
  const PAIR = '#pair=123456';

  it('ignores a page that was not opened from a pair link', () => {
    expect(pairStartupAction('', false, true)).toBe('ignore');
    expect(pairStartupAction('#chat', false, false)).toBe('ignore');
    expect(pairStartupAction('#pair=12345', false, true)).toBe('ignore');
  });

  it('pairs at once in a browser tab outside iOS (storage is shared with the installed app)', () => {
    expect(pairStartupAction(PAIR, false, false)).toBe('pair');
  });

  it('pairs at once when the page already runs as an installed app', () => {
    expect(pairStartupAction(PAIR, true, false)).toBe('pair');
    expect(pairStartupAction(PAIR, true, true)).toBe('pair');
  });

  it('shows the install guide on iOS in Safari and leaves the code unused', () => {
    expect(pairStartupAction(PAIR, false, true)).toBe('install-guide');
  });
});

describe('pairLinkStart', () => {
  const browser = { isStandalone: false, isIos: false };
  const iosSafari = { isStandalone: false, isIos: true };

  it('returns null when the URL has no valid pair link', () => {
    expect(pairLinkStart('', browser)).toBeNull();
    expect(pairLinkStart('#pair=12345', iosSafari)).toBeNull();
  });

  it('starts a pairing with the code outside iOS Safari', () => {
    expect(pairLinkStart('#pair=123456', browser)).toEqual({ code: '123456', action: 'pair' });
  });

  it('keeps the code for the install guide on iOS Safari', () => {
    expect(pairLinkStart('#pair=123456', iosSafari)).toEqual({ code: '123456', action: 'install-guide' });
  });
});

describe('isIosDevice', () => {
  it('recognises iPhone, iPod and iPad user agents', () => {
    expect(isIosDevice(IPHONE_UA, 'iPhone', 5)).toBe(true);
    expect(isIosDevice(IPAD_UA, 'iPad', 5)).toBe(true);
  });

  it('recognises iPadOS, which reports itself as a Mac with a touch screen', () => {
    expect(isIosDevice(MAC_UA, 'MacIntel', 5)).toBe(true);
  });

  it('does not take a Mac without a touch screen for iOS', () => {
    expect(isIosDevice(MAC_UA, 'MacIntel', 0)).toBe(false);
  });

  it('does not take Android or Windows for iOS', () => {
    expect(isIosDevice(ANDROID_UA, 'Linux armv8l', 5)).toBe(false);
    expect(isIosDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)).toBe(false);
  });
});

describe('isStandaloneApp', () => {
  it('is standalone when the display mode query matches', () => {
    expect(isStandaloneApp(true, undefined)).toBe(true);
  });

  it('is standalone on iOS when navigator.standalone is true', () => {
    expect(isStandaloneApp(false, true)).toBe(true);
  });

  it('is not standalone in a browser tab', () => {
    expect(isStandaloneApp(false, false)).toBe(false);
    expect(isStandaloneApp(false, undefined)).toBe(false);
  });
});
