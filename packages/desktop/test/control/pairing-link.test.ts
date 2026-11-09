import { describe, expect, it } from 'vitest';
import type { TailscaleStatus } from '../../src/common/types.js';
import { pairingLink, phoneOrigin } from '../../src/common/pairing-link.js';

const RUNNING: Extract<TailscaleStatus, { state: 'running' }> = {
  state: 'running',
  dnsName: 'nanachi-office-pc.tail1234.ts.net',
  tailnet: 'user@example.com',
  ips: ['100.64.0.5'],
};

describe('phoneOrigin', () => {
  it('is the HTTPS address of the embedded node on port 443, so no port is written', () => {
    expect(phoneOrigin(RUNNING)).toBe('https://nanachi-office-pc.tail1234.ts.net');
  });

  it('drops a trailing dot if one ever comes from the sidecar', () => {
    expect(phoneOrigin({ ...RUNNING, dnsName: 'nanachi-office-pc.tail1234.ts.net.' })).toBe('https://nanachi-office-pc.tail1234.ts.net');
  });

  it.each<[string, TailscaleStatus | null]>([
    ['no status yet', null],
    ['off', { state: 'off' }],
    ['starting', { state: 'starting' }],
    ['waiting for login', { state: 'needs_login', authUrl: 'https://login.tailscale.com/a/x' }],
    ['failed', { state: 'error', message: 'MagicDNS is off' }],
  ])('has no origin while Tailscale is %s', (_label, status) => {
    expect(phoneOrigin(status)).toBeNull();
  });

  it.each([
    ['an empty name', ''],
    ['a bare dot', '.'],
    ['a name with a path', 'pc.tail1.ts.net/evil'],
    ['a name with a port', 'pc.tail1.ts.net:8443'],
    ['a name with a space', 'pc tail1.ts.net'],
    ['an empty label', 'pc..ts.net'],
    ['a label that starts with a hyphen', '-pc.tail1.ts.net'],
    ['a name with an at sign', 'user@pc.tail1.ts.net'],
    ['a single label', 'localhost'],
  ])('refuses %s, so a malformed name never reaches the QR code', (_label, dnsName) => {
    expect(phoneOrigin({ ...RUNNING, dnsName })).toBeNull();
  });
});

describe('pairingLink', () => {
  const ORIGIN = 'https://nanachi-office-pc.tail1234.ts.net';

  it('puts the six digits in the fragment after the root of the origin', () => {
    expect(pairingLink(ORIGIN, '482915')).toBe('https://nanachi-office-pc.tail1234.ts.net/#pair=482915');
  });

  it('keeps the code out of the path and the query, which servers and logs see', () => {
    const link = pairingLink(ORIGIN, '000123');
    expect(link).not.toBeNull();
    const url = new URL(link ?? '');
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#pair=000123');
  });

  it('is null without an origin', () => {
    expect(pairingLink(null, '482915')).toBeNull();
  });

  it.each([
    ['five digits', '48291'],
    ['seven digits', '4829150'],
    ['letters', '48291a'],
    ['a space in the middle', '482 915'],
    ['an empty code', ''],
    ['a fragment that is already there', '#pair=482915'],
  ])('is null for a code with %s, since the contract is exactly six digits', (_label, code) => {
    expect(pairingLink(ORIGIN, code)).toBeNull();
  });
});
