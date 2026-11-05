import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccountLoginState } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountCheck } from '../src/agent-accounts.js';
import { ApiError } from '../src/api-error.js';
import { accountAdapterOf } from '../src/accounts/adapters.js';
import {
  LOGIN_RETAIN_MS,
  LOGIN_TIMEOUT_MS,
  createLoginManager,
  resolveLoginCommand,
  type LoginManager,
  type LoginManagerOptions,
  type LoginTarget,
  type Schedule,
} from '../src/accounts/login.js';
import { spawnTerminal, type TerminalProcess } from '../src/pty-process.js';
import { removeTempDir } from './temp.js';

const SAMPLES = JSON.parse(readFileSync(new URL('./fixtures/login-samples.json', import.meta.url), 'utf8')) as {
  claude: string;
  claudeUrl: string;
  codex: string;
};
const FIXTURE = fileURLToPath(new URL('./fixtures/login-fixture.mjs', import.meta.url));

const LOGGED_IN: AccountCheck = { status: 'logged_in', account: 'trabalho@exemplo.com', detail: null };
const PASTED = 'Zx9Qw-PASTED-CODE-abc123#state456';

function targetOf(agentId: string, accountId: string, overrides: Partial<LoginTarget> = {}): LoginTarget {
  const adapter = accountAdapterOf(agentId);
  if (adapter === undefined) throw new Error(`no adapter: ${agentId}`);
  return { agentId, accountId, adapter, principal: false, cwd: tmpdir(), env: { PATH: 'x' }, ...overrides };
}

/** Manual clock: timers only fire in `advance`. */
function manualClock(): { schedule: Schedule; advance(ms: number): void; pending(): number } {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    schedule: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        if (timers.delete(id)) timer.callback();
      }
    },
    pending: () => timers.size,
  };
}

interface FakeTerminal {
  terminal: TerminalProcess;
  written: string[];
  kills(): number;
  emit(chunk: string | Buffer): void;
  exit(code: number): void;
}

/** Fake PTY. `kill` makes the process "exit" (code 1) right after, like taskkill. */
function fakeTerminal(options: { exitOnKill?: boolean } = {}): FakeTerminal {
  const written: string[] = [];
  let dataListener: ((chunk: string | Buffer) => void) | undefined;
  let exitListener: ((code: number) => void) | undefined;
  let kills = 0;
  let gone = false;
  const exit = (code: number): void => {
    if (gone) return;
    gone = true;
    exitListener?.(code);
  };
  return {
    terminal: {
      onData: (listener) => {
        dataListener = listener;
      },
      onExit: (listener) => {
        exitListener = listener;
      },
      write: (data) => {
        written.push(data);
      },
      resize: () => undefined,
      kill: () => {
        kills++;
        if (options.exitOnKill !== false) queueMicrotask(() => exit(1));
      },
    },
    written,
    kills: () => kills,
    emit: (chunk) => dataListener?.(chunk),
    exit,
  };
}

interface Setup {
  manager: LoginManager;
  clock: ReturnType<typeof manualClock>;
  terminals: FakeTerminal[];
  prepared: LoginTarget[];
  spawned: Array<{ file: string; cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }>;
  logs: string[];
  verify: { result: AccountCheck | Error; calls: number; gate: Promise<void> | undefined };
}

function setup(overrides: Partial<LoginManagerOptions> = {}, terminalOptions: { exitOnKill?: boolean } = {}): Setup {
  const clock = manualClock();
  const state: Setup = {
    manager: undefined as unknown as LoginManager,
    clock,
    terminals: [],
    prepared: [],
    spawned: [],
    logs: [],
    verify: { result: LOGGED_IN, calls: 0, gate: undefined },
  };
  state.manager = createLoginManager({
    prepare: (target) => {
      state.prepared.push(target);
      return Promise.resolve();
    },
    verify: async () => {
      state.verify.calls++;
      await state.verify.gate;
      if (state.verify.result instanceof Error) throw state.verify.result;
      return state.verify.result;
    },
    resolveLogin: () => ({ file: 'fake-login', args: [], shell: false }),
    spawn: (command, spawnOptions) => {
      const fake = fakeTerminal(terminalOptions);
      state.terminals.push(fake);
      state.spawned.push({ file: command.file, cwd: spawnOptions.cwd, cols: spawnOptions.cols, rows: spawnOptions.rows, env: spawnOptions.env });
      return fake.terminal;
    },
    schedule: clock.schedule,
    log: (message) => state.logs.push(message),
    ...overrides,
  });
  return state;
}

/** Lets the pending promises (verification, exit) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function rejection(promise: Promise<unknown> | (() => unknown)): Promise<ApiError> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('login: states (fake PTY)', () => {
  it('the process starts at 500x50 with the target cwd and env; an extra account prepares its folder first; the principal does not', async () => {
    const s = setup();
    const extra = targetOf('claude', 'acc-1', { cwd: 'C:\\conta', env: { PATH: 'p', CLAUDE_CONFIG_DIR: 'C:\\conta' } });
    const started = await s.manager.start(extra);

    expect(started).toEqual({
      accountId: 'acc-1',
      state: 'starting',
      url: null,
      userCode: null,
      needsCode: true,
      codeSent: false,
      output: '',
      error: null,
      account: null,
    });
    expect(s.prepared).toEqual([extra]);
    expect(s.spawned).toEqual([{ file: 'fake-login', cwd: 'C:\\conta', cols: 500, rows: 50, env: { PATH: 'p', CLAUDE_CONFIG_DIR: 'C:\\conta' } }]);

    const principal = setup();
    await principal.manager.start(targetOf('claude', 'default', { principal: true }));
    expect(principal.prepared).toEqual([]);
    expect(principal.spawned).toHaveLength(1);
  });

  it('Claude: the link shows up and the state becomes waiting; the text comes out clean and there is no user code', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));

    s.terminals[0]?.emit(SAMPLES.claude);
    const state = s.manager.get('claude', 'acc-1');

    expect(state).toMatchObject({ state: 'waiting', url: SAMPLES.claudeUrl, userCode: null, needsCode: true, codeSent: false, error: null });
    expect(state?.output).toContain("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize");
    expect(state?.output.endsWith('Paste code here if prompted > ')).toBe(true);
    expect(state?.output).not.toContain('\u001b');
  });

  it('Codex: device link and code; needsCode is false', async () => {
    const s = setup();
    await s.manager.start(targetOf('codex', 'acc-2'));

    s.terminals[0]?.emit(SAMPLES.codex);

    expect(s.manager.get('codex', 'acc-2')).toMatchObject({
      state: 'waiting',
      url: 'https://auth.openai.com/codex/device',
      userCode: '0HKH-0YU99',
      needsCode: false,
    });
  });

  it('while the link arrives in pieces the state stays starting; a UTF-8 character cut in half is decoded whole', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    const term = s.terminals[0];

    term?.emit('Opening browser to sign in\u2026\r\nvisit: https://claude.com/ca');
    expect(s.manager.get('claude', 'acc-1')).toMatchObject({ state: 'starting', url: null });

    term?.emit('i/oauth/authorize?state=xyz\r\n');
    expect(s.manager.get('claude', 'acc-1')).toMatchObject({ state: 'waiting', url: 'https://claude.com/cai/oauth/authorize?state=xyz' });

    const bytes = Buffer.from('caf\u00e9 \u2026 ok\r\n', 'utf8');
    const cut = bytes.indexOf(0xc3) + 1;
    term?.emit(bytes.subarray(0, cut));
    term?.emit(bytes.subarray(cut));
    expect(s.manager.get('claude', 'acc-1')?.output).toContain('caf\u00e9 \u2026 ok');
  });

  it('a link seen once is kept when the text falls out of the buffer tail', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit('visit https://claude.com/a?b=1\r\n');
    s.terminals[0]?.emit('x'.repeat(250_000));

    expect(s.manager.get('claude', 'acc-1')?.url).toBe('https://claude.com/a?b=1');
  });

  it('output keeps only the last 4000 characters', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit(`${'a'.repeat(6000)}FIM`);

    const output = s.manager.get('claude', 'acc-1')?.output ?? '';
    expect(output).toHaveLength(4000);
    expect(output.endsWith('aaFIM')).toBe(true);
  });

  it('exit 0: becomes verifying, then succeeded with the e-mail; nothing is left for the timeout to do', async () => {
    const s = setup();
    let release: () => void = () => undefined;
    s.verify.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await s.manager.start(targetOf('codex', 'acc-2'));
    s.terminals[0]?.emit(SAMPLES.codex);

    s.terminals[0]?.exit(0);
    expect(s.manager.get('codex', 'acc-2')).toMatchObject({ state: 'verifying', url: 'https://auth.openai.com/codex/device', userCode: '0HKH-0YU99' });

    release();
    await settle();
    expect(s.manager.get('codex', 'acc-2')).toMatchObject({ state: 'succeeded', account: 'trabalho@exemplo.com', error: null });
    expect(s.verify.calls).toBe(1);

    // The 15 min timeout was disarmed: only the timer that drops the state (10 min) is left.
    expect(s.clock.pending()).toBe(1);
    s.clock.advance(LOGIN_RETAIN_MS - 1);
    expect(s.manager.get('codex', 'acc-2')?.state).toBe('succeeded');
    expect(s.terminals[0]?.kills()).toBe(0);
  });

  it('exit 0 with the account logged out: failed "o login terminou, mas a conta não aparece conectada"', async () => {
    const s = setup();
    s.verify.result = { status: 'logged_out', account: null, detail: null };
    await s.manager.start(targetOf('claude', 'acc-1'));

    s.terminals[0]?.exit(0);
    await settle();

    expect(s.manager.get('claude', 'acc-1')).toMatchObject({
      state: 'failed',
      error: 'o login terminou, mas a conta não aparece conectada',
      account: null,
    });
  });

  it('exit 0 without being able to check (unknown or error): failed, never treated as a connected account', async () => {
    for (const result of [{ status: 'unknown', account: null, detail: 'Tempo esgotado' } as AccountCheck, new Error('boom')]) {
      const s = setup();
      s.verify.result = result;
      await s.manager.start(targetOf('claude', 'acc-1'));
      s.terminals[0]?.exit(0);
      await settle();
      expect(s.manager.get('claude', 'acc-1')).toMatchObject({ state: 'failed', error: 'o login terminou, mas não foi possível conferir a conta' });
    }
  });

  it('non-zero exit: failed "o login falhou (código N)"', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit('Error: login was refused\r\n');

    s.terminals[0]?.exit(3);

    expect(s.manager.get('claude', 'acc-1')).toMatchObject({ state: 'failed', error: 'o login falhou (código 3)', account: null });
    expect(s.manager.get('claude', 'acc-1')?.output).toContain('Error: login was refused');
    expect(s.verify.calls).toBe(0);
  });

  it('15 minutes without finishing: the process is killed and the state is failed "tempo esgotado"', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));

    s.clock.advance(LOGIN_TIMEOUT_MS - 1);
    expect(s.manager.get('claude', 'acc-1')?.state).toBe('starting');
    expect(s.terminals[0]?.kills()).toBe(0);

    s.clock.advance(1);
    expect(s.manager.get('claude', 'acc-1')).toMatchObject({ state: 'failed', error: 'tempo esgotado' });
    expect(s.terminals[0]?.kills()).toBe(1);
    // The exit of the killed process does not change the state.
    await settle();
    expect(s.manager.get('claude', 'acc-1')).toMatchObject({ state: 'failed', error: 'tempo esgotado' });
  });

  it('cancel: kills the process, becomes cancelled and late output is ignored', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit(SAMPLES.claude);

    const cancelled = await s.manager.cancel('claude', 'acc-1');

    expect(cancelled).toMatchObject({ state: 'cancelled', error: null, url: SAMPLES.claudeUrl });
    expect(s.terminals[0]?.kills()).toBe(1);
    s.terminals[0]?.emit('more output after cancelling');
    expect(s.manager.get('claude', 'acc-1')?.output).not.toContain('after cancelling');
    expect(await s.manager.cancel('claude', 'acc-1')).toMatchObject({ state: 'cancelled' });
    expect(s.terminals[0]?.kills()).toBe(1);
  });

  it('cancel during verification: cancelled, and the verification result is ignored', async () => {
    const s = setup();
    let release: () => void = () => undefined;
    s.verify.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.exit(0);
    expect(s.manager.get('claude', 'acc-1')?.state).toBe('verifying');

    await s.manager.cancel('claude', 'acc-1');
    release();
    await settle();

    expect(s.manager.get('claude', 'acc-1')).toMatchObject({ state: 'cancelled', account: null });
  });

  it('cancel of a finished login leaves the state as it is; without a login it returns undefined', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.exit(2);

    expect(await s.manager.cancel('claude', 'acc-1')).toMatchObject({ state: 'failed', error: 'o login falhou (código 2)' });
    expect(await s.manager.cancel('claude', 'outra')).toBeUndefined();
  });

  it('a final state stays in memory for 10 minutes and then goes away', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.exit(1);

    s.clock.advance(LOGIN_RETAIN_MS - 1);
    expect(s.manager.get('claude', 'acc-1')?.state).toBe('failed');
    s.clock.advance(1);
    expect(s.manager.get('claude', 'acc-1')).toBeUndefined();
  });

  it('one login per agent: another account of the same agent is 409 login_in_progress; the same account returns the running state', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit(SAMPLES.claude);

    const error = await rejection(s.manager.start(targetOf('claude', 'acc-2')));
    expect(error).toMatchObject({ status: 409, code: 'login_in_progress' });

    const again = await s.manager.start(targetOf('claude', 'acc-1'));
    expect(again).toMatchObject({ state: 'waiting', url: SAMPLES.claudeUrl });
    expect(s.spawned).toHaveLength(1);

    // Another agent is not affected.
    await s.manager.start(targetOf('codex', 'acc-3'));
    expect(s.spawned).toHaveLength(2);
  });

  it('once a login is over, another account of the agent can log in; the same account starts again and replaces the old state', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.exit(1);

    await s.manager.start(targetOf('claude', 'acc-2'));
    expect(s.manager.get('claude', 'acc-2')?.state).toBe('starting');
    s.terminals[1]?.exit(1);

    await s.manager.start(targetOf('claude', 'acc-1'));
    expect(s.manager.get('claude', 'acc-1')).toMatchObject({ state: 'starting', error: null });
    expect(s.spawned).toHaveLength(3);
  });

  it('two calls at the same time: only one starts the process', async () => {
    const s = setup();
    const [a, b] = await Promise.allSettled([s.manager.start(targetOf('claude', 'acc-1')), s.manager.start(targetOf('claude', 'acc-2'))]);

    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect(s.spawned).toHaveLength(1);
  });

  it('failure to start (missing executable): failed state with the reason, without throwing', async () => {
    const s = setup({
      resolveLogin: () => {
        throw new Error('executável do agente não encontrado no PATH: claude');
      },
    });

    const state = await s.manager.start(targetOf('claude', 'acc-1'));

    expect(state).toMatchObject({ state: 'failed', error: 'não foi possível iniciar o login: executável do agente não encontrado no PATH: claude' });
    expect(s.spawned).toHaveLength(0);
    // Free to try again.
    await s.manager.start(targetOf('claude', 'acc-1'));
  });

  it('failure to prepare the folder: failed without starting the process, and the technical error only goes to the log', async () => {
    const s = setup({ prepare: () => Promise.reject(new Error('EPERM: C:\\privado')) });

    const state = await s.manager.start(targetOf('claude', 'acc-1'));

    expect(state).toMatchObject({ state: 'failed', error: 'não foi possível preparar a pasta da conta' });
    expect(JSON.stringify(state)).not.toContain('EPERM');
    expect(s.spawned).toHaveLength(0);
    expect(s.logs.join('\n')).toContain('EPERM');
  });

  it('cancelling while the folder is prepared: nothing starts when the preparation ends', async () => {
    let finishPrepare: () => void = () => undefined;
    const s = setup({
      prepare: () =>
        new Promise<void>((resolve) => {
          finishPrepare = resolve;
        }),
    });
    const starting = s.manager.start(targetOf('claude', 'acc-1'));
    expect(s.manager.get('claude', 'acc-1')?.state).toBe('starting');

    const cancelling = s.manager.cancel('claude', 'acc-1');
    finishPrepare();
    await Promise.all([starting, cancelling]);

    expect(s.manager.get('claude', 'acc-1')?.state).toBe('cancelled');
    expect(s.spawned).toHaveLength(0);
  });

  it('discard: kills the process, waits for it to exit and forgets the state; no retention timer is left', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    const before = s.clock.pending();

    await s.manager.discard('claude', 'acc-1');

    expect(s.terminals[0]?.kills()).toBe(1);
    expect(s.manager.get('claude', 'acc-1')).toBeUndefined();
    expect(s.clock.pending()).toBeLessThan(before);
    await s.manager.discard('claude', 'nunca-teve');
  });

  it('discard waits for the process to exit, but only up to a limit', async () => {
    const s = setup({}, { exitOnKill: false });
    await s.manager.start(targetOf('claude', 'acc-1'));
    let done = false;

    const discarding = s.manager.discard('claude', 'acc-1').then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);

    s.clock.advance(5_000);
    await discarding;
    expect(done).toBe(true);
  });

  it('shutdown kills every running login', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    await s.manager.start(targetOf('codex', 'acc-2'));

    await s.manager.shutdown();

    expect(s.terminals.map((terminal) => terminal.kills())).toEqual([1, 1]);
    expect(s.manager.get('claude', 'acc-1')).toBeUndefined();
  });
});

describe('login: pasted code (fake PTY)', () => {
  it('writes code + CR to the process, sets codeSent and does not return the code', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit(SAMPLES.claude);

    const state = s.manager.submitCode('claude', 'acc-1', PASTED);

    expect(s.terminals[0]?.written).toEqual([`${PASTED}\r`]);
    expect(state).toMatchObject({ state: 'waiting', codeSent: true });
    expect(JSON.stringify(state)).not.toContain(PASTED);
  });

  it('an echo of the code in the terminal comes out as ••••, while the login runs and after it ends', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit(SAMPLES.claude);
    s.manager.submitCode('claude', 'acc-1', PASTED);

    s.terminals[0]?.emit(`${PASTED}\r\n`);
    const running = s.manager.get('claude', 'acc-1');
    expect(running?.output).toContain('Paste code here if prompted > ');
    expect(running?.output).toContain('••••');
    expect(running?.output).not.toContain(PASTED);

    // The echo may come in pieces, and the terminal may redraw with cursor moves between characters.
    s.terminals[0]?.emit('\u001b[2K\u001b[1G> Zx9Qw-PASTED-');
    s.terminals[0]?.emit('CODE-abc\u001b[1C123#sta');
    s.terminals[0]?.emit('te456\r\n');
    s.terminals[0]?.emit('Login successful\r\n');
    s.terminals[0]?.exit(0);
    await settle();

    const done = s.manager.get('claude', 'acc-1');
    expect(done?.state).toBe('succeeded');
    expect(done?.output).toContain('Login successful');
    expect(done?.output).not.toContain('PASTED');
    expect(done?.output).not.toContain('abc123');
    expect(done?.output.match(/••••/g)?.length).toBe(2);
  });

  it('the code never goes to the log or the error, also when the login fails', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit(SAMPLES.claude);
    s.manager.submitCode('claude', 'acc-1', PASTED);
    s.terminals[0]?.emit(`${PASTED}\r\nInvalid code\r\n`);
    s.verify.result = new Error(`boom ${PASTED}`);
    s.terminals[0]?.exit(0);
    await settle();

    const state = s.manager.get('claude', 'acc-1');
    expect(state?.state).toBe('failed');
    expect(JSON.stringify(state)).not.toContain(PASTED);
    // What the CLI printed is never logged.
    expect(s.logs.join('\n')).not.toContain('Invalid code');
    expect(s.logs.join('\n')).not.toContain('Paste code here');
  });

  it('the code only works with needsCode and in waiting; otherwise 409 invalid_state', async () => {
    const s = setup();

    // Before the link shows up (starting).
    await s.manager.start(targetOf('claude', 'acc-1'));
    expect(await rejection(() => s.manager.submitCode('claude', 'acc-1', 'abc'))).toMatchObject({ status: 409, code: 'invalid_state' });
    expect(s.terminals[0]?.written).toEqual([]);

    // Codex does not ask for a code.
    await s.manager.start(targetOf('codex', 'acc-2'));
    s.terminals[1]?.emit(SAMPLES.codex);
    expect(s.manager.get('codex', 'acc-2')?.state).toBe('waiting');
    expect(await rejection(() => s.manager.submitCode('codex', 'acc-2', 'abc'))).toMatchObject({ status: 409, code: 'invalid_state' });
    expect(s.terminals[1]?.written).toEqual([]);

    // After it finished.
    s.terminals[0]?.emit(SAMPLES.claude);
    s.terminals[0]?.exit(1);
    expect(await rejection(() => s.manager.submitCode('claude', 'acc-1', 'abc'))).toMatchObject({ status: 409, code: 'invalid_state' });
  });

  it('no login for the account: 404 not_found', async () => {
    const s = setup();
    expect(await rejection(() => s.manager.submitCode('claude', 'acc-1', 'abc'))).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('a process that refuses the write: 409 invalid_state and codeSent stays false', async () => {
    const s = setup();
    await s.manager.start(targetOf('claude', 'acc-1'));
    s.terminals[0]?.emit(SAMPLES.claude);
    const original = s.terminals[0]?.terminal;
    if (original !== undefined) {
      original.write = () => {
        throw new Error('EPIPE');
      };
    }

    expect(await rejection(() => s.manager.submitCode('claude', 'acc-1', 'abc'))).toMatchObject({ status: 409, code: 'invalid_state' });
    expect(s.manager.get('claude', 'acc-1')?.codeSent).toBe(false);
  });
});

describe('resolveLoginCommand', () => {
  it('Claude: `claude auth login` found on the target PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nanachi-login-bin-'));
    try {
      const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
      await writeFile(join(dir, exe), '');
      const target = targetOf('claude', 'default', { env: { PATH: dir, PATHEXT: '.EXE' } });

      const command = resolveLoginCommand(target.adapter, target);

      expect(command).toMatchObject({ file: join(dir, exe), args: ['auth', 'login'], shell: false });
    } finally {
      await removeTempDir(dir);
    }
  });

  it('Claude: executable missing from the PATH throws (the manager turns it into a failed state)', () => {
    const target = targetOf('claude', 'default', { env: { PATH: '' } });
    expect(() => resolveLoginCommand(target.adapter, target)).toThrow(/não encontrado/);
  });

  it('Codex: the bundled codex with `login --device-auth`, run by the daemon node', () => {
    const target = targetOf('codex', 'acc-1', { env: { PATH: '' } });

    const command = resolveLoginCommand(target.adapter, target);

    expect(command.shell).toBe(false);
    expect(command.args.slice(-2)).toEqual(['login', '--device-auth']);
    expect(command.args.length).toBe(3);
    expect(command.args[0]).toMatch(/codex\.js$/);
    expect(command.file.toLowerCase()).toBe(process.execPath.toLowerCase());
  });

  it('Codex: CODEX_PATH from the env wins over the bundled one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nanachi-login-codex-'));
    try {
      const custom = join(dir, 'codex-custom.exe');
      await writeFile(custom, '');
      const target = targetOf('codex', 'acc-1', { env: { PATH: '', CODEX_PATH: custom } });

      expect(resolveLoginCommand(target.adapter, target)).toMatchObject({ file: custom, args: ['login', '--device-auth'], shell: false });
    } finally {
      await removeTempDir(dir);
    }
  });
});

/** Starts a real PTY (node-pty) and kills it at once. Without one, the tests with a real process are skipped. */
function ptyAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const probe = spawnTerminal(
      { file: process.env.ComSpec ?? 'cmd.exe', args: [], shell: false },
      { cwd: tmpdir(), env: process.env, cols: 80, rows: 24 },
    );
    probe.kill();
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ptyAvailable())('login: fixture commands in a real PTY', () => {
  let base: string;
  let home: string;
  let outDir: string;
  let manager: LoginManager;
  let mode: string[];
  const leak = 'NANACHI_TEST_LEAK';

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'nanachi-login-'));
    home = join(base, 'conta');
    outDir = join(base, 'saida');
    await mkdir(home);
    mode = ['claude'];
  });

  afterEach(async () => {
    await manager?.shutdown();
    await removeTempDir(base);
  });

  function create(overrides: Partial<LoginManagerOptions> = {}): LoginManager {
    manager = createLoginManager({
      prepare: () => Promise.resolve(),
      // The test "credential" is a marker in the account folder; no real credential is ever read.
      verify: () =>
        Promise.resolve(
          existsSync(join(home, 'logged-in.marker')) ? LOGGED_IN : { status: 'logged_out', account: null, detail: null },
        ),
      resolveLogin: () => ({ file: process.execPath, args: [FIXTURE, ...mode], shell: false }),
      ...overrides,
    });
    return manager;
  }

  function target(agentId: string, overrides: Partial<LoginTarget> = {}): LoginTarget {
    const adapter = accountAdapterOf(agentId);
    const homeEnv = adapter?.homeEnv ?? 'CLAUDE_CONFIG_DIR';
    return targetOf(agentId, 'acc-1', {
      cwd: home,
      env: { ...process.env, [homeEnv]: home, LOGIN_OUT_DIR: outDir },
      ...overrides,
    });
  }

  async function reach(agentId: string, accountId: string, wanted: AccountLoginState['state']): Promise<AccountLoginState> {
    return waitFor(() => {
      const state = manager.get(agentId, accountId);
      return state?.state === wanted ? state : undefined;
    }, `state ${wanted}`);
  }

  it('Claude: the OSC 8 link becomes the url, the pasted code goes in, the "credential" shows up and the login ends with the e-mail', async () => {
    mode = ['claude', 'echo'];
    create();
    await manager.start(target('claude'));

    const waiting = await reach('claude', 'acc-1', 'waiting');
    expect(waiting).toMatchObject({ url: SAMPLES.claudeUrl, userCode: null, needsCode: true, codeSent: false });
    expect(waiting.output).toContain('Paste code here if prompted >');

    const sent = manager.submitCode('claude', 'acc-1', PASTED);
    expect(sent.codeSent).toBe(true);
    const done = await reach('claude', 'acc-1', 'succeeded');

    expect(done).toMatchObject({ account: 'trabalho@exemplo.com', error: null, codeSent: true, url: SAMPLES.claudeUrl });
    expect(done.output).toContain('Login successful');
    expect(done.output).toContain('••••');
    expect(JSON.stringify(done)).not.toContain('PASTED-CODE');
    expect(existsSync(join(home, 'logged-in.marker'))).toBe(true);

    const seen = JSON.parse(readFileSync(join(outDir, 'env.json'), 'utf8')) as { cwd: string; columns: number };
    expect(seen.columns).toBe(500);
    expect(seen.cwd.toLowerCase()).toBe(home.toLowerCase());
  });

  it('Codex: url and code show up while the CLI waits; after it exits with 0 the account is checked', async () => {
    mode = ['codex', 'hold'];
    create();
    await manager.start(target('codex'));

    const waiting = await reach('codex', 'acc-1', 'waiting');
    expect(waiting).toMatchObject({ url: 'https://auth.openai.com/codex/device', userCode: '0HKH-0YU99', needsCode: false });
    expect(await rejection(() => manager.submitCode('codex', 'acc-1', 'x'))).toMatchObject({ code: 'invalid_state' });

    await writeFile(join(home, 'release'), '');
    const done = await reach('codex', 'acc-1', 'succeeded');
    expect(done).toMatchObject({ account: 'trabalho@exemplo.com', userCode: '0HKH-0YU99' });
  });

  it('a CLI that exits with 1: failed "o login falhou (código 1)", with its output', async () => {
    mode = ['fail'];
    create();
    await manager.start(target('claude'));

    const failed = await reach('claude', 'acc-1', 'failed');

    expect(failed.error).toBe('o login falhou (código 1)');
    expect(failed.output).toContain('Error: login was refused');
  });

  it('a CLI that exits with 0 without a credential: failed "a conta não aparece conectada"', async () => {
    mode = ['codex'];
    create();
    // The CLI writes the marker elsewhere: the account folder (the one the verifier checks) has nothing.
    const elsewhere = join(base, 'outra');
    await mkdir(elsewhere);
    await manager.start(target('codex', { env: { ...process.env, CODEX_HOME: elsewhere, LOGIN_OUT_DIR: outDir } }));

    const failed = await reach('codex', 'acc-1', 'failed');

    expect(failed.error).toBe('o login terminou, mas a conta não aparece conectada');
    expect(existsSync(join(elsewhere, 'logged-in.marker'))).toBe(true);
    expect(existsSync(join(home, 'logged-in.marker'))).toBe(false);
  });

  it('a CLI that never exits: DELETE kills the tree and the process goes away', async () => {
    mode = ['hang'];
    create();
    await manager.start(target('codex'));
    await reach('codex', 'acc-1', 'waiting');
    const pid = Number(readFileSync(join(outDir, 'pid'), 'utf8'));
    expect(alive(pid)).toBe(true);

    const cancelled = await manager.cancel('codex', 'acc-1');

    expect(cancelled?.state).toBe('cancelled');
    await waitFor(() => (alive(pid) ? undefined : true), 'the process to exit');
  });

  it('a CLI that never exits: 15 minutes on the fake clock kill the process and give "tempo esgotado"', async () => {
    mode = ['hang'];
    const clock = manualClock();
    create({ schedule: clock.schedule });
    await manager.start(target('codex'));
    await reach('codex', 'acc-1', 'waiting');
    const pid = Number(readFileSync(join(outDir, 'pid'), 'utf8'));

    clock.advance(LOGIN_TIMEOUT_MS);

    expect(manager.get('codex', 'acc-1')).toMatchObject({ state: 'failed', error: 'tempo esgotado' });
    await waitFor(() => (alive(pid) ? undefined : true), 'the process to exit');
  });
});
