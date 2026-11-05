import { describe, expect, it } from 'vitest';
import { checkForUpdate, evaluateRelease, RELEASES_LATEST_URL, releasePageUrl } from '../src/main/updates.js';

const release = (tag: string, assets: string[] = ['Nanachi-Setup-1.0.0.exe'], extra: object = {}): object => ({
  tag_name: tag,
  html_url: 'https://evil.example/phish',
  draft: false,
  prerelease: false,
  assets: assets.map((name) => ({ name })),
  ...extra,
});

describe('evaluateRelease', () => {
  it('offers a newer tag that carries the installer, with a release page built from the tag', () => {
    expect(evaluateRelease('0.1.0', release('v0.2.0', ['Nanachi-Setup-0.2.0.exe']))).toEqual({
      status: 'available',
      current: '0.1.0',
      latest: '0.2.0',
      url: 'https://github.com/j-carv/nanachi-remote-control/releases/tag/v0.2.0',
    });
  });

  it('never trusts html_url from the answer', () => {
    const result = evaluateRelease('0.1.0', release('v0.2.0'));
    expect(result.status === 'available' && result.url.startsWith('https://github.com/j-carv/')).toBe(true);
  });

  it.each([
    ['same version', '0.1.0', 'v0.1.0'],
    ['older version', '0.3.0', 'v0.2.9'],
    ['tag without the v', '0.1.0', '0.1.0'],
  ])('is up to date for %s', (_label, current, tag) => {
    expect(evaluateRelease(current, release(tag))).toEqual({ status: 'up-to-date', current });
  });

  it('compares numerically, not as text (0.10.0 is newer than 0.9.0)', () => {
    expect(evaluateRelease('0.9.0', release('v0.10.0')).status).toBe('available');
    expect(evaluateRelease('0.10.0', release('v0.9.0')).status).toBe('up-to-date');
  });

  it('orders prereleases below the release', () => {
    expect(evaluateRelease('1.0.0-beta.1', release('v1.0.0')).status).toBe('available');
    expect(evaluateRelease('1.0.0', release('v1.0.0-rc.1')).status).toBe('up-to-date');
  });

  it('ignores a newer release that has no installer asset', () => {
    expect(evaluateRelease('0.1.0', release('v0.2.0', ['source.zip', 'notes.txt'])).status).toBe('up-to-date');
    expect(evaluateRelease('0.1.0', release('v0.2.0', [])).status).toBe('up-to-date');
  });

  it('matches only Nanachi-Setup-*.exe', () => {
    expect(evaluateRelease('0.1.0', release('v0.2.0', ['Other-Setup-0.2.0.exe'])).status).toBe('up-to-date');
    expect(evaluateRelease('0.1.0', release('v0.2.0', ['Nanachi-Setup-0.2.0.zip'])).status).toBe('up-to-date');
  });

  it('ignores drafts and prereleases', () => {
    expect(evaluateRelease('0.1.0', release('v0.2.0', undefined, { draft: true })).status).toBe('up-to-date');
    expect(evaluateRelease('0.1.0', release('v0.2.0', undefined, { prerelease: true })).status).toBe('up-to-date');
  });

  it.each([null, 'text', 42, [], {}, { tag_name: 5 }, { tag_name: 'latest' }])('survives a malformed body: %j', (body) => {
    expect(evaluateRelease('0.1.0', body)).toEqual({ status: 'up-to-date', current: '0.1.0' });
  });

  it('survives assets that are not objects', () => {
    expect(evaluateRelease('0.1.0', { tag_name: 'v0.2.0', assets: [null, 'x', 5, { name: 3 }] }).status).toBe('up-to-date');
  });
});

describe('releasePageUrl', () => {
  it('escapes the tag', () => {
    expect(releasePageUrl('v1.0.0/../../x')).toBe(
      'https://github.com/j-carv/nanachi-remote-control/releases/tag/v1.0.0%2F..%2F..%2Fx',
    );
  });
});

describe('checkForUpdate', () => {
  function fakeFetch(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
      return Promise.resolve(respond());
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it('asks GitHub for the latest release, anonymously', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response(JSON.stringify(release('v0.2.0')), { status: 200 }));
    const result = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl });

    expect(result.status).toBe('available');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(RELEASES_LATEST_URL);
    expect(RELEASES_LATEST_URL).toBe('https://api.github.com/repos/j-carv/nanachi-remote-control/releases/latest');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
    expect(headers['user-agent']).toBe('Nanachi-Desktop/0.1.0');
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it('treats 404 (nothing published yet) as up to date', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('{}', { status: 404 }));
    expect(await checkForUpdate({ currentVersion: '0.1.0', fetchImpl })).toEqual({ status: 'up-to-date', current: '0.1.0' });
  });

  it('reports other HTTP failures, such as a rate limit', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('{}', { status: 403 }));
    expect(await checkForUpdate({ currentVersion: '0.1.0', fetchImpl })).toEqual({
      status: 'error',
      current: '0.1.0',
      message: 'O GitHub respondeu HTTP 403.',
    });
  });

  it('reports a network failure', async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')));
    const result = await checkForUpdate({ currentVersion: '0.1.0', fetchImpl });
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toMatch(/ENOTFOUND/);
  });

  it('reports an unreadable body', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect((await checkForUpdate({ currentVersion: '0.1.0', fetchImpl })).status).toBe('error');
  });
});
