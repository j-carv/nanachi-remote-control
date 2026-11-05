import { describe, expect, it, vi } from 'vitest';
import { runReported } from '../../src/control/lib/guard.js';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Actions nobody waits for (open a folder, open a page): a refusal from main must reach the user, not an unhandled rejection. */
describe('runReported', () => {
  it('says nothing when the action works', async () => {
    const report = vi.fn();
    const run = vi.fn(() => Promise.resolve());
    runReported(run, report);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a rejection (main refused the address, the channel threw)', async () => {
    const report = vi.fn();
    runReported(() => Promise.reject(new TypeError('endereço não permitido')), report);
    await settle();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('reports an action that throws before it returns a promise (a bridge that refuses the channel)', async () => {
    const report = vi.fn();
    expect(() =>
      runReported(() => {
        throw new Error('canal não permitido');
      }, report),
    ).not.toThrow();
    await settle();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('a report that itself throws does not become an unhandled rejection (vitest fails the run on one)', async () => {
    const report = vi.fn(() => {
      throw new Error('o aviso também falhou');
    });
    runReported(() => Promise.reject(new Error('x')), report);
    await settle();
    await settle();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
