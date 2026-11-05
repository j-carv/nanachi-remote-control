import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../src/rate-limit.js';

describe('createRateLimiter', () => {
  it('deixa passar até `max` eventos na janela e recusa o seguinte', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 1000 });
    expect(limiter.take('device', 0)).toBe(true);
    expect(limiter.take('device', 10)).toBe(true);
    expect(limiter.take('device', 20)).toBe(false);
  });

  it('libera de novo quando o evento mais antigo sai da janela', () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 1000 });
    limiter.take('device', 0);
    limiter.take('device', 10);
    expect(limiter.take('device', 999)).toBe(false);
    expect(limiter.take('device', 1000)).toBe(true);
  });

  it('conta cada chave à parte', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('b', 0)).toBe(true);
    expect(limiter.take('a', 1)).toBe(false);
  });

  it('evento recusado não entra na conta', () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.take('a', 0)).toBe(true);
    expect(limiter.take('a', 500)).toBe(false);
    expect(limiter.take('a', 1000)).toBe(true);
  });
});
