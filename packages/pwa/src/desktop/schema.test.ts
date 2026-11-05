import { describe, expect, it } from 'vitest';
import {
  isHttpsUrl,
  parseDaemonStatus,
  parsePairingCode,
  parseTailscaleStatus,
  parseUpdateCheck,
} from './schema.js';

const DAEMON = {
  state: 'running',
  port: 7811,
  mode: 'spawned',
  pid: 4242,
  version: '1.2.3',
  machineName: 'PC',
  restricted: false,
  message: null,
  logTail: [],
};

describe('isHttpsUrl', () => {
  it('accepts https and nothing else', () => {
    expect(isHttpsUrl('https://login.tailscale.com/a/abc')).toBe(true);
    expect(isHttpsUrl('http://login.tailscale.com/a/abc')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isHttpsUrl('not a url')).toBe(false);
  });
});

describe('parseDaemonStatus', () => {
  it('accepts what the main process sends and drops unknown keys', () => {
    expect(parseDaemonStatus({ ...DAEMON, extra: 'x' })).toEqual(DAEMON);
  });

  it.each([
    ['null', null],
    ['an unknown state', { ...DAEMON, state: 'sleeping' }],
    ['a port out of range', { ...DAEMON, port: 70000 }],
    ['a missing restricted flag', { ...DAEMON, restricted: undefined }],
    ['a logTail that is not a list', { ...DAEMON, logTail: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(parseDaemonStatus(value)).toBeNull();
  });
});

describe('parseTailscaleStatus', () => {
  it('accepts the five states', () => {
    expect(parseTailscaleStatus({ state: 'off' })).toEqual({ state: 'off' });
    expect(parseTailscaleStatus({ state: 'starting' })).toEqual({ state: 'starting' });
    expect(parseTailscaleStatus({ state: 'needs_login', authUrl: 'https://login.tailscale.com/a/x' })).toEqual({
      state: 'needs_login',
      authUrl: 'https://login.tailscale.com/a/x',
    });
    expect(parseTailscaleStatus({ state: 'running', dnsName: 'a.ts.net', tailnet: 't', ips: ['100.64.0.1'] })).toEqual({
      state: 'running',
      dnsName: 'a.ts.net',
      tailnet: 't',
      ips: ['100.64.0.1'],
    });
    expect(parseTailscaleStatus({ state: 'error', message: 'boom' })).toEqual({ state: 'error', message: 'boom' });
  });

  it.each([
    ['an http login URL', { state: 'needs_login', authUrl: 'http://login.tailscale.com/a/x' }],
    ['a javascript: login URL', { state: 'needs_login', authUrl: 'javascript:alert(1)' }],
    ['a login without a URL', { state: 'needs_login' }],
    ['running without a dns name', { state: 'running', dnsName: '', tailnet: 't', ips: [] }],
    ['an unknown state', { state: 'connecting' }],
    ['a string', 'running'],
  ])('rejects %s', (_label, value) => {
    expect(parseTailscaleStatus(value)).toBeNull();
  });
});

describe('parsePairingCode', () => {
  it('accepts six digits and an expiry', () => {
    expect(parsePairingCode({ code: '123456', expiresAt: 1_700_000_000_000 })).toEqual({ code: '123456', expiresAt: 1_700_000_000_000 });
  });

  it.each([
    ['five digits', { code: '12345', expiresAt: 1 }],
    ['letters', { code: 'abcdef', expiresAt: 1 }],
    ['no expiry', { code: '123456' }],
  ])('rejects %s', (_label, value) => {
    expect(parsePairingCode(value)).toBeNull();
  });
});

describe('parseUpdateCheck', () => {
  it('accepts the three results', () => {
    expect(parseUpdateCheck({ status: 'up-to-date', current: '0.1.0' })).toEqual({ status: 'up-to-date', current: '0.1.0' });
    expect(
      parseUpdateCheck({ status: 'available', current: '0.1.0', latest: '0.2.0', url: 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v0.2.0' }),
    ).toMatchObject({ status: 'available', latest: '0.2.0' });
    expect(parseUpdateCheck({ status: 'error', current: '0.1.0', message: 'sem rede' })).toEqual({ status: 'error', current: '0.1.0', message: 'sem rede' });
  });

  it('never accepts a release link that is not https', () => {
    expect(parseUpdateCheck({ status: 'available', current: '0.1.0', latest: '0.2.0', url: 'javascript:alert(1)' })).toBeNull();
    expect(parseUpdateCheck({ status: 'available', current: '0.1.0', latest: '0.2.0', url: 'http://github.com/x' })).toBeNull();
  });
});
