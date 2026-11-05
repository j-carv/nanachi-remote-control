import { describe, expect, it } from 'vitest';
import { cacheBustPath, withoutCacheBust } from './cacheBust.js';

describe('cacheBustPath', () => {
  it('builds the current path with ?v=<now>', () => {
    expect(cacheBustPath('/', 1234)).toBe('/?v=1234');
    expect(cacheBustPath('/app/', 99)).toBe('/app/?v=99');
  });
});

describe('withoutCacheBust', () => {
  it('removes v and keeps the other parameters and the hash', () => {
    expect(withoutCacheBust('https://nanachi.example/?v=1234&x=1#sessao')).toBe('https://nanachi.example/?x=1#sessao');
  });

  it('removes v when it is the only parameter', () => {
    expect(withoutCacheBust('https://nanachi.example/?v=1234')).toBe('https://nanachi.example/');
  });

  it('returns null when there is no v', () => {
    expect(withoutCacheBust('https://nanachi.example/?x=1')).toBeNull();
    expect(withoutCacheBust('https://nanachi.example/')).toBeNull();
  });
});
