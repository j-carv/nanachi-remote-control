import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import './zodJitless.js';

describe('zodJitless', () => {
  it('liga o modo sem JIT do zod (sem new Function, que a CSP bloqueia)', () => {
    expect(z.config().jitless).toBe(true);
  });
});
