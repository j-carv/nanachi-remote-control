import { describe, expect, it } from 'vitest';
import { serveOrigin } from '../src/main/tailscale-serve-origin.js';

const host = 'nanachi.example.ts.net:443';

function status(proxy: string, funnel = false): string {
  return JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: { [host]: { Handlers: { '/': { Proxy: proxy } } } },
    AllowFunnel: { [host]: funnel },
  });
}

describe('External Tailscale pairing address', () => {
  it('finds a private HTTPS route to this daemon', () => {
    expect(serveOrigin(status('http://localhost:7777'), 7777)).toBe('https://nanachi.example.ts.net');
    expect(serveOrigin(status('http://127.0.0.1:7777/'), 7777)).toBe('https://nanachi.example.ts.net');
  });

  it('ignores public, unrelated and malformed configurations', () => {
    expect(serveOrigin(status('http://localhost:7777', true), 7777)).toBeNull();
    expect(serveOrigin(status('http://localhost:8080'), 7777)).toBeNull();
    expect(serveOrigin(status('http://localhost:7777/elsewhere'), 7777)).toBeNull();
    expect(serveOrigin(status('http://localhost:7777').replace('nanachi.example.ts.net', 'other.example.com'), 7777)).toBeNull();
    expect(serveOrigin('not JSON', 7777)).toBeNull();
  });
});
