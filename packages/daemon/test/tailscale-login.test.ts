import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, trustedTailscaleLogin } from '../src/tailscale-login.js';

describe('isLoopbackAddress', () => {
  it('aceita loopback IPv4, IPv6 e IPv6 mapeado em IPv4', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.8.9.10')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('recusa qualquer outro endereço, ausente ou vazio', () => {
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('fe80::1')).toBe(false);
    expect(isLoopbackAddress('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('trustedTailscaleLogin', () => {
  it('devolve o login do header quando o peer é loopback', () => {
    expect(trustedTailscaleLogin('127.0.0.1', 'joao@exemplo.com')).toBe('joao@exemplo.com');
  });

  it('ignora o header quando o peer não é loopback', () => {
    expect(trustedTailscaleLogin('10.0.0.5', 'joao@exemplo.com')).toBeUndefined();
  });

  it('header ausente, vazio ou repetido não vale', () => {
    expect(trustedTailscaleLogin('127.0.0.1', undefined)).toBeUndefined();
    expect(trustedTailscaleLogin('127.0.0.1', '')).toBeUndefined();
    expect(trustedTailscaleLogin('127.0.0.1', ['a@x', 'b@x'])).toBeUndefined();
  });
});
