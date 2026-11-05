import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResetError, ResetService, type ResetServiceOptions, type ResetTarget } from '../src/reset-service.js';
import { UsageProbeError } from '../src/usage-probe.js';
import { waitUntilDead } from './agent-support.js';
import { removeTempDir } from './temp.js';

/*
 * ResetService on its own (reset-service.ts): the omp side runs on a scripted usage probe that the test answers by hand,
 * the codex side on the fake app-server (test/fixtures/fake-codex-app-server.mjs). Neither talks to a real agent, so no
 * reset is ever spent. The route-level behaviour is in usage-resets-routes.test.ts.
 */

const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

let base: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-reset-service-')));
});

afterEach(async () => {
  await removeTempDir(base);
});

/** Lets pending promise callbacks and the calls they make run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Warning {
  fields: unknown;
  message: string | undefined;
}

/** A logger that keeps what the service warns about. */
function capturedLog(): { log: ResetServiceOptions['log']; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const log: ResetServiceOptions['log'] = {
    warn: (fields: unknown, message?: string) => {
      warnings.push({ fields, message });
    },
    debug: () => undefined,
  };
  return { log, warnings };
}

interface ScriptedCall {
  text: string;
  accountId: string | null | undefined;
  resolve(reply: string): void;
  reject(error: Error): void;
}

/** A usage probe whose commands stay pending until the test answers them: the test owns the order of the replies. */
function scriptedUsage(): { usage: ResetServiceOptions['usage']; calls: ScriptedCall[]; forgets: number } {
  const calls: ScriptedCall[] = [];
  const state = { forgets: 0 };
  const usage: ResetServiceOptions['usage'] = {
    command: (_agentId, _agent, text, accountId) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ text, accountId, resolve, reject });
      }),
    forget: () => {
      state.forgets += 1;
    },
  };
  return {
    usage,
    calls,
    get forgets() {
      return state.forgets;
    },
  };
}

function serviceWith(options: Partial<ResetServiceOptions> & Pick<ResetServiceOptions, 'usage'>): ResetService {
  return new ResetService({
    workRoot: base,
    appVersion: '9.9.9',
    timeoutMs: 10_000,
    cacheMs: 60_000,
    log: capturedLog().log,
    ...options,
  });
}

const OMP_AGENT: AgentConfig = { label: 'omp', command: 'omp', args: [], env: {}, kind: 'acp' };
const OMP_TARGET: ResetTarget = { agentId: 'omp', agent: OMP_AGENT };

const LISTING_ONE_USABLE = '- a@b.c [Anthropic · anthropic/1]: 1 saved, 1 usable now';
const LISTING_NONE_USABLE = '- a@b.c [Anthropic · anthropic/1]: 0 saved, 0 usable now';
const RESET_APPLIED = 'Reset applied for a@b.c (Anthropic) — 5h session limit refreshed.';

describe('omp: a listing and a redeem on the same key', () => {
  it('a listing that started before a redeem is not joined after it, and its answer never reaches the cache', async () => {
    const script = scriptedUsage();
    const service = serviceWith({ usage: script.usage });

    const stale = service.list(OMP_TARGET);
    await settle();
    expect(script.calls.map((call) => call.text)).toEqual(['/usage reset']);

    const redeem = service.redeem(OMP_TARGET, 'anthropic/1');
    await settle();
    script.calls[1]?.resolve(RESET_APPLIED);
    expect((await redeem).outcome).toBe('reset');

    // The redeem is over, the first listing is still out: a new request must ask again, not take the old answer.
    const fresh = service.list(OMP_TARGET);
    await settle();
    expect(script.calls.map((call) => call.text)).toEqual(['/usage reset', '/usage reset anthropic/1', '/usage reset']);

    script.calls[2]?.resolve(LISTING_NONE_USABLE);
    expect((await fresh).entries[0]?.usable).toBe(0);
    // The old listing ends last. It answers its own callers, and leaves the cache as the fresh one set it.
    script.calls[0]?.resolve(LISTING_ONE_USABLE);
    expect((await stale).entries[0]?.usable).toBe(1);

    const again = await service.list(OMP_TARGET);
    expect(again.cached).toBe(true);
    expect(again.entries[0]?.usable).toBe(0);
    expect(script.calls).toHaveLength(3);
  });

  it('a listing that starts while a redeem runs is not cached either', async () => {
    const script = scriptedUsage();
    const service = serviceWith({ usage: script.usage });

    const redeem = service.redeem(OMP_TARGET, 'anthropic/1');
    await settle();
    const during = service.list(OMP_TARGET);
    await settle();

    script.calls[0]?.resolve(RESET_APPLIED);
    await redeem;
    script.calls[1]?.resolve(LISTING_ONE_USABLE);
    await during;

    const next = service.list(OMP_TARGET);
    await settle();
    expect(script.calls).toHaveLength(3);
    script.calls[2]?.resolve(LISTING_NONE_USABLE);
    expect((await next).cached).toBeUndefined();
  });

  it('callers that arrive together still share one listing', async () => {
    const script = scriptedUsage();
    const service = serviceWith({ usage: script.usage });

    const first = service.list(OMP_TARGET);
    const second = service.list(OMP_TARGET);
    await settle();
    expect(script.calls).toHaveLength(1);
    script.calls[0]?.resolve(LISTING_ONE_USABLE);
    expect((await first).entries).toEqual((await second).entries);
  });
});

describe('a redeem that times out', () => {
  it('omp: logs that the outcome is unknown, without secrets, and answers agent_timeout', async () => {
    const script = scriptedUsage();
    const { log, warnings } = capturedLog();
    const service = serviceWith({ usage: script.usage, log });

    const redeem = service.redeem(OMP_TARGET, 'anthropic/1').catch((error: unknown) => error);
    await settle();
    script.calls[0]?.reject(new UsageProbeError('agent_timeout', 'agente não respondeu'));
    const error = await redeem;

    expect(error).toBeInstanceOf(ResetError);
    expect(error).toMatchObject({ code: 'agent_timeout' });
    const unknown = warnings.filter((warning) => warning.message === 'reset outcome unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.fields).toEqual({ agent: 'omp', source: 'omp' });
  });

  it('omp: a failure that is not a timeout, and a listing that times out, do not say that', async () => {
    const script = scriptedUsage();
    const { log, warnings } = capturedLog();
    const service = serviceWith({ usage: script.usage, log });

    const failed = service.redeem(OMP_TARGET, 'anthropic/1').catch((error: unknown) => error);
    await settle();
    script.calls[0]?.reject(new UsageProbeError('agent_failed', 'processo caiu'));
    expect(await failed).toMatchObject({ code: 'agent_failed' });

    const listing = service.list(OMP_TARGET).catch((error: unknown) => error);
    await settle();
    script.calls[1]?.reject(new UsageProbeError('agent_timeout', 'agente não respondeu'));
    expect(await listing).toMatchObject({ code: 'agent_timeout' });

    expect(warnings.some((warning) => warning.message === 'reset outcome unknown')).toBe(false);
  });
});

describe('codex (app-server falso)', () => {
  /** Alvo do codex; `env` vale só para os processos desta chamada (extraEnv), o resto vai no env do agente. */
  function codexTarget(env: Record<string, string> = {}, agentEnv: Record<string, string> = {}): ResetTarget {
    const agent: AgentConfig = {
      label: 'Codex',
      command: 'codex-acp',
      args: [],
      env: { CODEX_PATH: CODEX_FIXTURE, ...agentEnv },
      kind: 'acp',
    };
    return { agentId: 'codex', agent, extraEnv: env };
  }

  /** Waits until a fixture process has recorded a message with that method. */
  async function waitForRecorded(record: string, method: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const text = await readFile(record, 'utf8').catch(() => '');
      if (text.split('\n').some((line) => line.includes(`"method":"${method}"`))) return;
      if (Date.now() > deadline) throw new Error(`the fixture never received ${method}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('a listing that started before a redeem is not joined after it and does not set the known credits', async () => {
    const gate = join(base, 'gate');
    const record = join(base, 'rec.jsonl');
    const service = serviceWith({ usage: scriptedUsage().usage });
    const stale = codexTarget({ FAKE_CODEX_RATE_LIMITS_GATE: gate }, { FAKE_CODEX_RECORD: record });
    const fresh = codexTarget({ FAKE_CODEX_CREDITS: 'renewed' }, { FAKE_CODEX_RECORD: record });

    // The first listing reaches the backend and is held there: it will answer with the credits as they were.
    const staleListing = service.list(stale);
    await waitForRecorded(record, 'account/rateLimits/read');

    expect((await service.redeem(stale, 'next')).outcome).toBe('nothing_to_reset');

    // A new request after the redeem reads again (and sees the renewed credits) instead of waiting for the old one.
    const freshListing = await service.list(fresh);
    expect(freshListing.entries.map((entry) => entry.target)).toEqual(['credit-4']);

    // The old listing ends last, with the old credit ids. They must not become the known ones.
    await writeFile(gate, '');
    const staleResponse = await staleListing;
    expect(staleResponse.entries.map((entry) => entry.target)).toEqual(['credit-2']);

    const cached = await service.list(fresh);
    expect(cached.cached).toBe(true);
    expect(cached.entries.map((entry) => entry.target)).toEqual(['credit-4']);

    await expect(service.redeem(fresh, 'credit-2')).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await service.redeem(fresh, 'credit-4')).outcome).toBe('already_redeemed');
  });

  it('a redeem that times out logs that the outcome is unknown and answers agent_timeout', async () => {
    const { log, warnings } = capturedLog();
    const service = serviceWith({ usage: scriptedUsage().usage, log, timeoutMs: 2_500 });

    const error = await service.redeem(codexTarget({ FAKE_CODEX_CONSUME: 'hang' }), 'next').catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'agent_timeout' });
    const unknown = warnings.filter((warning) => warning.message === 'reset outcome unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.fields).toEqual({ agent: 'codex', source: 'codex' });
  });

  it('close() kills the app-server that is in flight and fails the listing', async () => {
    const pidFile = join(base, 'pid');
    const record = join(base, 'rec.jsonl');
    const service = serviceWith({ usage: scriptedUsage().usage, timeoutMs: 30_000 });
    const target = codexTarget(
      { FAKE_CODEX_CREDITS: 'hang' },
      { FAKE_CODEX_PID_FILE: pidFile, FAKE_CODEX_RECORD: record },
    );

    const listing = service.list(target).catch((error: unknown) => error);
    await waitForRecorded(record, 'account/rateLimits/read');

    service.close();
    expect(await listing).toMatchObject({ code: 'agent_failed' });
    expect(await waitUntilDead(Number(await readFile(pidFile, 'utf8')))).toBe(true);
  });

  it('after close() nothing starts an app-server any more', async () => {
    const pidFile = join(base, 'pid');
    const service = serviceWith({ usage: scriptedUsage().usage });
    service.close();

    const target = codexTarget({}, { FAKE_CODEX_PID_FILE: pidFile });
    await expect(service.list(target)).rejects.toMatchObject({ code: 'agent_failed' });
    await expect(service.redeem(target, 'next')).rejects.toMatchObject({ code: 'agent_failed' });
    expect(existsSync(pidFile)).toBe(false);
  });
});
