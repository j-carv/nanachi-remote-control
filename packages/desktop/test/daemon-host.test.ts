import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonStatus } from '../src/common/types.js';
import { DaemonHost, RESTRICTED_MESSAGE, type ChildLike, type DaemonHostDeps, type HealthInfo } from '../src/main/daemon-host.js';
import type { HealthProbe } from '../src/main/system.js';
import type { DaemonRuntime } from '../src/main/daemon-runtime.js';

const RUNTIME: DaemonRuntime = {
  nodePath: 'C:\\Nanachi\\resources\\runtime\\node.exe',
  daemonMain: 'C:\\Nanachi\\resources\\runtime\\packages\\daemon\\dist\\main.js',
  daemonCli: 'C:\\Nanachi\\resources\\runtime\\packages\\daemon\\dist\\cli.js',
  cwd: 'C:\\Nanachi\\resources\\runtime',
  packaged: true,
};

const HEALTH: HealthInfo = { machineId: 'm-1', machineName: 'OFFICE-PC', version: '1.2.3' };

/** What the fake port answers: a healthy daemon, a daemon that refuses local calls, or nothing. */
type Answer = HealthInfo | 'restricted' | null;

function probe(answer: Answer): HealthProbe {
  if (answer === null) return { kind: 'none' };
  if (answer === 'restricted') return { kind: 'restricted' };
  return { kind: 'ok', info: answer };
}

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  constructor(readonly pid: number | undefined) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

interface Harness {
  host: DaemonHost;
  children: FakeChild[];
  spawnCalls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>;
  /** Every call of `ensureConfig`, and what the spawn count was at that moment (it must come before the spawn). */
  configCalls: Array<{ home: string; spawnsSoFar: number }>;
  killed: number[];
  logged: string[];
  setHealth(value: Answer): void;
  statuses: DaemonStatus[];
}

function harness(overrides: Partial<DaemonHostDeps> = {}, initialHealth: Answer = null): Harness {
  let health = initialHealth;
  const children: FakeChild[] = [];
  const spawnCalls: Harness['spawnCalls'] = [];
  const configCalls: Harness['configCalls'] = [];
  const killed: number[] = [];
  const logged: string[] = [];
  let nextPid = 4000;

  const deps: DaemonHostDeps = {
    home: 'C:\\Users\\user\\.nanachi-desktop',
    runtime: RUNTIME,
    readPort: () => 7811,
    ensureConfig: (home) => {
      configCalls.push({ home, spawnsSoFar: spawnCalls.length });
    },
    health: () => Promise.resolve(probe(health)),
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
      const child = new FakeChild(nextPid++);
      children.push(child);
      return child;
    },
    killTree: (pid) => {
      killed.push(pid);
      // taskkill ends the process: the exit event follows.
      children.find((child) => child.pid === pid)?.exit(1);
      return Promise.resolve();
    },
    log: {
      append: (text) => {
        logged.push(text);
      },
      tail: () => ['last line 1', 'last line 2'],
    },
    missingFile: () => null,
    env: { PATH: 'x' },
    gracefulStopMs: 5_000,
    startupTimeoutMs: 30_000,
    pollIntervalMs: 250,
    ...overrides,
  };
  const host = new DaemonHost(deps);
  const statuses: DaemonStatus[] = [];
  host.onStatus((status) => statuses.push(status));
  return {
    host,
    children,
    spawnCalls,
    configCalls,
    killed,
    logged,
    statuses,
    setHealth(value) {
      health = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('attach mode', () => {
  it('does not spawn when a Nanachi daemon already answers, and reports it', async () => {
    const h = harness({}, HEALTH);
    await h.host.start();

    expect(h.spawnCalls).toHaveLength(0);
    expect(h.host.status()).toMatchObject({
      state: 'attached',
      mode: 'attached',
      port: 7811,
      pid: null,
      version: '1.2.3',
      machineName: 'OFFICE-PC',
    });
  });

  it('never stops a daemon it did not start', async () => {
    const h = harness({}, HEALTH);
    await h.host.start();
    await h.host.stop();

    expect(h.killed).toEqual([]);
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.host.status().state).toBe('stopped');
  });

  it('start() again while attached does nothing', async () => {
    const h = harness({}, HEALTH);
    await h.host.start();
    await h.host.start();
    expect(h.spawnCalls).toHaveLength(0);
  });
});

describe('restricted daemon (allowedTailscaleLogins set)', () => {
  it('attaches without spawning, flags it as restricted and explains why', async () => {
    const h = harness({}, 'restricted');
    await h.host.start();

    expect(h.spawnCalls).toHaveLength(0);
    expect(h.host.status()).toMatchObject({
      state: 'attached',
      mode: 'attached',
      restricted: true,
      version: null,
      machineName: null,
      message: RESTRICTED_MESSAGE,
    });
    expect(RESTRICTED_MESSAGE).toMatch(/allowedTailscaleLogins/);
  });

  it('names Desktop\'s own folder and says the panel needs the list empty (not NANACHI_HOME)', () => {
    expect(RESTRICTED_MESSAGE).toMatch(/\.nanachi-desktop/);
    expect(RESTRICTED_MESSAGE).toMatch(/vazi/);
    expect(RESTRICTED_MESSAGE).not.toMatch(/NANACHI_HOME|\.nanachi-remote/);
  });

  it('never stops it', async () => {
    const h = harness({}, 'restricted');
    await h.host.start();
    await h.host.stop();
    expect(h.killed).toEqual([]);
    expect(h.host.status().restricted).toBe(false);
  });

  it('a daemon Desktop spawned that turns out to refuse local calls is running, not crashing', async () => {
    const h = harness();
    await h.host.start();
    h.setHealth('restricted');
    await vi.advanceTimersByTimeAsync(250);

    expect(h.host.status()).toMatchObject({ state: 'running', mode: 'spawned', restricted: true, message: RESTRICTED_MESSAGE });
    // No kill, no restart: the process is fine, it is the panel that cannot use it.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.killed).toEqual([]);
    expect(h.spawnCalls).toHaveLength(1);
  });
});

describe('spawn mode', () => {
  it('spawns the daemon with NANACHI_HOME and the runtime paths, then reports running once health answers', async () => {
    const h = harness();
    await h.host.start();

    expect(h.spawnCalls).toEqual([
      {
        command: RUNTIME.nodePath,
        args: [RUNTIME.daemonMain],
        cwd: RUNTIME.cwd,
        env: { PATH: 'x', NANACHI_HOME: 'C:\\Users\\user\\.nanachi-desktop' },
      },
    ]);
    expect(h.host.status()).toMatchObject({ state: 'starting', mode: 'spawned', pid: 4000 });

    // The daemon is slow to come up: three polls go unanswered.
    await vi.advanceTimersByTimeAsync(750);
    expect(h.host.status().state).toBe('starting');
    h.setHealth(HEALTH);
    await vi.advanceTimersByTimeAsync(250);

    expect(h.host.status()).toMatchObject({
      state: 'running',
      mode: 'spawned',
      pid: 4000,
      version: '1.2.3',
      machineName: 'OFFICE-PC',
      message: null,
    });
  });

  it('passes Desktop\'s folder as NANACHI_HOME even when the environment already has another one', async () => {
    const h = harness({ env: { PATH: 'x', NANACHI_HOME: 'C:\\Users\\user\\.nanachi-remote' } });
    await h.host.start();
    expect(h.spawnCalls[0]?.env.NANACHI_HOME).toBe('C:\\Users\\user\\.nanachi-desktop');
  });

  it('makes sure config.json exists in its own folder before every spawn, never after', async () => {
    const h = harness();
    await h.host.start();
    expect(h.configCalls).toEqual([{ home: 'C:\\Users\\user\\.nanachi-desktop', spawnsSoFar: 0 }]);

    // A crash restarts the daemon: the check runs again, before the new spawn.
    h.children[0]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.configCalls).toEqual([
      { home: 'C:\\Users\\user\\.nanachi-desktop', spawnsSoFar: 0 },
      { home: 'C:\\Users\\user\\.nanachi-desktop', spawnsSoFar: 1 },
    ]);
  });

  it('does not touch config.json when it attaches to a daemon that already answers', async () => {
    const h = harness({}, HEALTH);
    await h.host.start();
    expect(h.configCalls).toEqual([]);
  });

  it('reports an error, and spawns nothing, when config.json cannot be prepared (a daemon would create one with port 7777)', async () => {
    const h = harness({
      ensureConfig: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    await h.host.start();
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.host.status()).toMatchObject({ state: 'error', mode: 'none' });
    expect(h.host.status().message).toMatch(/\.nanachi-desktop/);
    expect(h.host.status().message).toMatch(/EACCES/);
  });

  it('appends the daemon stdout and stderr to the log', async () => {
    const h = harness();
    await h.host.start();
    h.children[0]?.stdout.emit('data', Buffer.from('{"msg":"listening"}\n'));
    h.children[0]?.stderr.emit('data', 'boom\n');
    expect(h.logged).toContain('{"msg":"listening"}\n');
    expect(h.logged).toContain('boom\n');
  });

  it('reports an error without spawning when a runtime file is missing', async () => {
    const h = harness({ missingFile: () => 'C:\\Nanachi\\resources\\runtime\\node.exe' });
    await h.host.start();

    expect(h.spawnCalls).toHaveLength(0);
    expect(h.host.status()).toMatchObject({
      state: 'error',
      mode: 'none',
      message: 'Arquivo do runtime ausente: C:\\Nanachi\\resources\\runtime\\node.exe',
    });
  });

  it('treats a spawn failure (ENOENT) like a crash and retries', async () => {
    const h = harness();
    await h.host.start();
    h.children[0]?.emit('error', new Error('spawn node ENOENT'));
    expect(h.host.status().state).toBe('starting');
    expect(h.host.status().message).toMatch(/ENOENT/);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('survives a synchronous spawn exception', async () => {
    let calls = 0;
    const h = harness({
      spawn: () => {
        calls += 1;
        throw new Error('EINVAL');
      },
    });
    await h.host.start();
    expect(calls).toBe(1);
    expect(h.host.status().state).toBe('starting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });

  it('kills and retries a daemon that never answers health', async () => {
    const h = harness({ startupTimeoutMs: 2_000 });
    await h.host.start();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(h.killed).toEqual([4000]);
    expect(h.logged.join('')).toMatch(/não respondeu/);
    // The exit that follows the kill schedules the restart.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.spawnCalls).toHaveLength(2);
  });
});

describe('crash handling', () => {
  async function crashAndWait(h: Harness, index: number, waitMs: number): Promise<void> {
    h.setHealth(HEALTH);
    h.children[index]?.exit(1);
    h.setHealth(null);
    await vi.advanceTimersByTimeAsync(waitMs);
  }

  it('restarts after 1 s, 2 s, 5 s and 10 s, and the last delay repeats', async () => {
    const h = harness();
    await h.host.start();
    expect(h.spawnCalls).toHaveLength(1);

    h.children[0]?.exit(1);
    expect(h.host.status().state).toBe('starting');
    await vi.advanceTimersByTimeAsync(999);
    expect(h.spawnCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawnCalls).toHaveLength(2);

    h.children[1]?.exit(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.spawnCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawnCalls).toHaveLength(3);

    h.children[2]?.exit(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.spawnCalls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawnCalls).toHaveLength(4);

    h.children[3]?.exit(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.spawnCalls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.spawnCalls).toHaveLength(5);

    h.children[4]?.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawnCalls).toHaveLength(6);
  });

  it('gives up after more than 5 crashes in 2 minutes, with the log tail for the panel', async () => {
    const h = harness();
    await h.host.start();
    const waits = [1_000, 2_000, 5_000, 10_000, 10_000];
    for (let i = 0; i < 5; i++) await crashAndWait(h, i, waits[i] ?? 10_000);
    expect(h.spawnCalls).toHaveLength(6);
    expect(h.host.status().state).toBe('starting');

    h.children[5]?.exit(1);
    expect(h.host.status()).toMatchObject({
      state: 'error',
      mode: 'none',
      pid: null,
      logTail: ['last line 1', 'last line 2'],
    });
    expect(h.host.status().message).toMatch(/6 vezes/);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.spawnCalls).toHaveLength(6);
  });

  it('does not count crashes that are more than 2 minutes apart', async () => {
    const h = harness();
    await h.host.start();
    for (let i = 0; i < 8; i++) {
      h.children[i]?.exit(1);
      await vi.advanceTimersByTimeAsync(121_000);
    }
    expect(h.host.status().state).not.toBe('error');
    expect(h.spawnCalls.length).toBeGreaterThanOrEqual(9);
  });

  it('attaches instead of spawning when someone else started a daemon during the backoff', async () => {
    const h = harness();
    await h.host.start();
    h.children[0]?.exit(1);
    h.setHealth(HEALTH);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.host.status()).toMatchObject({ state: 'attached', mode: 'attached' });
  });

  it('start() after giving up tries again from a clean slate', async () => {
    const h = harness({ maxCrashes: 0 });
    await h.host.start();
    h.children[0]?.exit(1);
    expect(h.host.status().state).toBe('error');

    h.setHealth(null);
    await h.host.start();
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.host.status().state).toBe('starting');
  });
});

describe('stop', () => {
  async function runningHarness(overrides: Partial<DaemonHostDeps> = {}): Promise<Harness> {
    const h = harness(overrides);
    await h.host.start();
    h.setHealth(HEALTH);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.host.status().state).toBe('running');
    return h;
  }

  it('asks politely, and does not kill the tree when the daemon exits within the grace period', async () => {
    const h = await runningHarness();
    const stopping = h.host.stop();
    expect(h.children[0]?.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1_000);
    h.children[0]?.exit(0);
    await stopping;

    expect(h.killed).toEqual([]);
    expect(h.host.status()).toMatchObject({ state: 'stopped', mode: 'none', pid: null });
  });

  it('kills the whole tree when the daemon is still alive after the grace period', async () => {
    const h = await runningHarness();
    const stopping = h.host.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopping;

    expect(h.killed).toEqual([4000]);
    expect(h.host.status().state).toBe('stopped');
  });

  it('skips the polite step and kills the tree at once when the grace period is 0 (Windows)', async () => {
    const h = await runningHarness({ gracefulStopMs: 0 });
    await h.host.stop();

    expect(h.children[0]?.signals).toEqual([]);
    expect(h.killed).toEqual([4000]);
  });

  it('does not restart the daemon it just stopped', async () => {
    const h = await runningHarness({ gracefulStopMs: 0 });
    await h.host.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('cancels a pending restart', async () => {
    const h = harness();
    await h.host.start();
    h.children[0]?.exit(1);
    await h.host.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.host.status().state).toBe('stopped');
  });

  it('stopping while the first health probe is in flight spawns nothing', async () => {
    let release: (value: HealthProbe) => void = () => undefined;
    const h = harness({
      health: () =>
        new Promise<HealthProbe>((resolve) => {
          release = resolve;
        }),
    });
    const starting = h.host.start();
    await h.host.stop();
    release({ kind: 'none' });
    await starting;
    expect(h.spawnCalls).toHaveLength(0);
  });
});

describe('status events', () => {
  it('notifies listeners on every change and stops after unsubscribe', async () => {
    const h = harness({ gracefulStopMs: 0 });
    const seen: string[] = [];
    const off = h.host.onStatus((status) => seen.push(status.state));
    await h.host.start();
    h.setHealth(HEALTH);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toContain('starting');
    expect(seen.at(-1)).toBe('running');

    off();
    const count = seen.length;
    await h.host.stop();
    expect(seen).toHaveLength(count);
  });
});

describe('an attached daemon that goes away', () => {
  /** A health probe the test can answer and count. */
  function counting(initial: Answer): { health: DaemonHostDeps['health']; set(value: Answer): void; calls: () => number } {
    let answer = initial;
    let calls = 0;
    return {
      health: () => {
        calls += 1;
        return Promise.resolve(probe(answer));
      },
      set: (value) => {
        answer = value;
      },
      calls: () => calls,
    };
  }

  it('probes /api/health every 10 s while attached', async () => {
    const health = counting(HEALTH);
    const h = harness({ health: health.health });
    await h.host.start();
    expect(health.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(health.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(health.calls()).toBe(5);
    expect(h.host.status()).toMatchObject({ state: 'attached', mode: 'attached' });
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('after three misses in a row it takes over: the port is free, so it spawns its own daemon', async () => {
    const health = counting(HEALTH);
    const h = harness({ health: health.health });
    await h.host.start();
    health.set(null);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    // Two misses are not enough: the supervisor may just be reloading the daemon.
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.host.status().state).toBe('attached');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.host.status()).toMatchObject({ state: 'starting', mode: 'spawned', pid: 4000 });
    expect(h.logged.join('')).toMatch(/parou de responder/);
  });

  it('an answer in between resets the count', async () => {
    const health = counting(HEALTH);
    const h = harness({ health: health.health });
    await h.host.start();

    health.set(null);
    await vi.advanceTimersByTimeAsync(20_000);
    health.set(HEALTH);
    await vi.advanceTimersByTimeAsync(10_000);
    health.set(null);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.spawnCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('attaches again, and does not spawn, when the daemon is back by the time it gives up on it', async () => {
    // Call 1: the first attach. Calls 2 to 4: three misses. Call 5: the confirmation in begin() finds it again.
    const script: Answer[] = [HEALTH, null, null, null, HEALTH];
    let call = 0;
    const h = harness({
      health: () => {
        const answer = script[Math.min(call, script.length - 1)] ?? null;
        call += 1;
        return Promise.resolve(probe(answer));
      },
    });
    await h.host.start();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(call).toBeGreaterThanOrEqual(5);
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.host.status()).toMatchObject({ state: 'attached', mode: 'attached' });
  });

  it('keeps the attached status current when the daemon is replaced by another version', async () => {
    const health = counting(HEALTH);
    const h = harness({ health: health.health });
    await h.host.start();
    health.set({ ...HEALTH, version: '2.0.0' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.status()).toMatchObject({ state: 'attached', version: '2.0.0' });

    health.set('restricted');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.host.status()).toMatchObject({ state: 'attached', restricted: true, message: RESTRICTED_MESSAGE });
  });

  it('also watches a restricted daemon', async () => {
    const health = counting('restricted');
    const h = harness({ health: health.health });
    await h.host.start();
    health.set(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('stop() ends the watch', async () => {
    const health = counting(HEALTH);
    const h = harness({ health: health.health });
    await h.host.start();
    await h.host.stop();
    const before = health.calls();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(health.calls()).toBe(before);
  });

  it('attachedProbeMs 0 turns the watch off', async () => {
    const health = counting(HEALTH);
    const h = harness({ health: health.health, attachedProbeMs: 0 });
    await h.host.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(health.calls()).toBe(1);
  });

  it('a daemon Desktop spawned is not probed by the watch (its exit event is the signal)', async () => {
    const health = counting(null);
    const h = harness({ health: health.health, pollIntervalMs: 60_000 });
    await h.host.start();
    expect(h.host.status().mode).toBe('spawned');
    // begin() + the first startup poll only; no 10 s probing on top.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(health.calls()).toBe(2);
  });
});

describe('a port held by another program', () => {
  it('is reported as "porta ocupada" and no daemon is spawned into it', async () => {
    const h = harness({ portFree: () => Promise.resolve(false), portRecheckMs: 10 });
    const started = h.host.start();
    await vi.advanceTimersByTimeAsync(100);
    await started;

    expect(h.spawnCalls).toHaveLength(0);
    expect(h.host.status()).toMatchObject({ state: 'error', mode: 'none' });
    expect(h.host.status().message).toMatch(/porta 7811 está ocupada por outro programa/);
    expect(h.host.status().message).toMatch(/config\.json/);
  });

  it('does not turn into a crash loop: no spawns, only an occasional look', async () => {
    let looks = 0;
    const h = harness({
      portFree: () => {
        looks += 1;
        return Promise.resolve(false);
      },
      portRecheckMs: 10,
    });
    const started = h.host.start();
    await vi.advanceTimersByTimeAsync(100);
    await started;
    const first = looks;
    expect(first).toBe(3);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.spawnCalls).toHaveLength(0);
    // One more round of looks every 15 s: four rounds in a minute, not one spawn per second.
    expect(looks - first).toBeLessThanOrEqual(3 * 4);
    expect(h.host.status().state).toBe('error');
  });

  it('spawns once the program lets go of the port', async () => {
    let free = false;
    const h = harness({ portFree: () => Promise.resolve(free), portRecheckMs: 10 });
    const started = h.host.start();
    await vi.advanceTimersByTimeAsync(100);
    await started;
    expect(h.host.status().state).toBe('error');

    free = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.host.status()).toMatchObject({ state: 'starting', mode: 'spawned' });
  });

  it('gives the port a moment: a daemon that was just killed may still hold it', async () => {
    let looks = 0;
    const h = harness({
      portFree: () => {
        looks += 1;
        return Promise.resolve(looks >= 2);
      },
      portRecheckMs: 10,
    });
    const started = h.host.start();
    await vi.advanceTimersByTimeAsync(100);
    await started;
    expect(h.spawnCalls).toHaveLength(1);
    expect(looks).toBe(2);
  });

  it('is not consulted when a Nanachi daemon already answers on the port', async () => {
    let looks = 0;
    const h = harness(
      {
        portFree: () => {
          looks += 1;
          return Promise.resolve(false);
        },
      },
      HEALTH,
    );
    await h.host.start();
    expect(looks).toBe(0);
    expect(h.host.status().state).toBe('attached');
  });

  it('stop() cancels the retry', async () => {
    const h = harness({ portFree: () => Promise.resolve(false), portRecheckMs: 10 });
    const started = h.host.start();
    await vi.advanceTimersByTimeAsync(100);
    await started;
    await h.host.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.host.status().state).toBe('stopped');
    expect(h.spawnCalls).toHaveLength(0);
  });
});
