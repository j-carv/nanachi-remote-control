import { describe, expect, it } from 'vitest';
import { RELOAD_EXIT_CODE } from '../src/reload-watch.js';
import { RestartPolicy, RESTART_BACKOFF_MS, STABLE_RUN_MS } from '../src/supervisor-policy.js';

describe('RestartPolicy', () => {
  it('reload (código 75) reinicia na hora e não conta como falha', () => {
    const policy = new RestartPolicy();
    expect(policy.nextDelay({ code: RELOAD_EXIT_CODE, ranMs: 500 })).toBe(0);
    expect(policy.nextDelay({ code: 1, ranMs: 500 })).toBe(1000);
  });

  it('falhas seguidas seguem 1s, 2s, 5s, 10s e depois 30s para sempre', () => {
    const policy = new RestartPolicy();
    const delays = [1, 2, 3, 4, 5, 6].map(() => policy.nextDelay({ code: 1, ranMs: 100 }));
    expect(delays).toEqual([1000, 2000, 5000, 10000, 30000, 30000]);
    expect(RESTART_BACKOFF_MS.at(-1)).toBe(30000);
  });

  it('zera o backoff depois de rodar um tempo estável', () => {
    const policy = new RestartPolicy();
    policy.nextDelay({ code: 1, ranMs: 100 });
    policy.nextDelay({ code: 1, ranMs: 100 });
    expect(policy.nextDelay({ code: 1, ranMs: STABLE_RUN_MS })).toBe(1000);
  });

  it('código 0 inesperado também entra no backoff', () => {
    expect(new RestartPolicy().nextDelay({ code: 0, ranMs: 10 })).toBe(1000);
  });
});
