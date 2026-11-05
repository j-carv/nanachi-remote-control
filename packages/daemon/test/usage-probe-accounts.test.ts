import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '@nanachi/shared';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageProbe, UsageProbeError, type UsageProbeOptions } from '../src/usage-probe.js';
import { removeTempDir } from './temp.js';

/*
 * UsageProbe and extra accounts: an account that is being removed gets no probe at all (no slot, no folder, no process),
 * and a read in flight shows as busy. No agent process is started: `launch` is a stand-in that must not be reached, or
 * the read is held in `prepare`.
 */

const AGENT: AgentConfig = { label: 'Fake', command: 'fake', args: [], env: {}, kind: 'acp' };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nanachi-usage-probe-'));
});

afterEach(async () => {
  await removeTempDir(root);
});

function probeWith(overrides: Partial<UsageProbeOptions> = {}): { probe: UsageProbe; launch: ReturnType<typeof vi.fn> } {
  const launch = vi.fn(() => {
    throw new Error('no process in this test');
  });
  const probe = new UsageProbe({
    root,
    launch,
    log: Fastify({ logger: false }).log,
    timeoutMs: 5_000,
    cacheMs: 0,
    idleMs: 1_000,
    cancelGraceMs: 100,
    ...overrides,
  });
  return { probe, launch };
}

function slotCount(probe: UsageProbe): number {
  return (probe as unknown as { slots: Map<string, unknown> }).slots.size;
}

describe('UsageProbe: account being removed', () => {
  it('read: refused as agent_failed, with no slot, no prepare and no process', async () => {
    const prepare = vi.fn(() => Promise.resolve());
    const { probe, launch } = probeWith({ blocked: (_agent, account) => account === 'going', prepare });

    const outcome = await probe.read('claude', AGENT, '/usage', 'going').catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(UsageProbeError);
    expect(outcome).toMatchObject({ code: 'agent_failed' });
    expect(slotCount(probe)).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('command (the resets turns): the same', async () => {
    const { probe, launch } = probeWith({ blocked: () => true });

    await expect(probe.command('codex', AGENT, '/usage reset', 'going')).rejects.toMatchObject({ code: 'agent_failed' });

    expect(slotCount(probe)).toBe(0);
    expect(launch).not.toHaveBeenCalled();
  });

  it('the principal is never blocked, and neither is another account', async () => {
    const prepare = vi.fn(() => Promise.reject(new Error('stop here')));
    const { probe } = probeWith({ blocked: (_agent, account) => account === 'going', prepare });

    // The reads get as far as `prepare` (the account one) or `launch` (the principal): no refusal for being blocked.
    await expect(probe.read('claude', AGENT, '/usage', 'other')).rejects.toMatchObject({ message: expect.stringContaining('stop here') });
    await expect(probe.read('claude', AGENT, '/usage', null)).rejects.toMatchObject({ message: expect.stringContaining('no process') });
    expect(slotCount(probe)).toBe(2);
  });
});

describe('UsageProbe.isBusy', () => {
  it('true while a read of the account is in flight, false before and after, and only for that account', async () => {
    let release: (value: undefined) => void = () => undefined;
    const held = new Promise<undefined>((resolveHeld) => {
      release = resolveHeld;
    });
    const prepare = vi.fn(() => held.then(() => Promise.reject(new Error('stop here'))));
    const { probe } = probeWith({ prepare });

    expect(probe.isBusy('claude', 'a')).toBe(false);
    const reading = probe.read('claude', AGENT, '/usage', 'a').catch((error: unknown) => error);
    expect(probe.isBusy('claude', 'a')).toBe(true);
    expect(probe.isBusy('claude', 'b')).toBe(false);
    expect(probe.isBusy('codex', 'a')).toBe(false);

    release(undefined);
    await reading;

    expect(probe.isBusy('claude', 'a')).toBe(false);
  });

  it('a queued command counts too', async () => {
    let release: (value: undefined) => void = () => undefined;
    const held = new Promise<undefined>((resolveHeld) => {
      release = resolveHeld;
    });
    const prepare = vi.fn(() => held.then(() => Promise.reject(new Error('stop here'))));
    const { probe } = probeWith({ prepare });

    const first = probe.command('codex', AGENT, '/usage reset', 'a').catch((error: unknown) => error);
    const second = probe.command('codex', AGENT, '/usage reset next', 'a').catch((error: unknown) => error);
    expect(probe.isBusy('codex', 'a')).toBe(true);

    release(undefined);
    await Promise.all([first, second]);

    expect(probe.isBusy('codex', 'a')).toBe(false);
  });
});
