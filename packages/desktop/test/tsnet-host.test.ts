import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TailscaleStatus } from '../src/common/types.js';
import {
  createLineSplitter,
  createTsnetHost,
  parseTsnetLine,
  resolveSidecarPath,
  SIDECAR_EXE_ENV,
  SIDECAR_EXE_NAME,
  sidecarArgs,
  statusFromEvent,
  tsnetHostname,
  type TsnetChild,
  type TsnetHost,
  type TsnetHostDeps,
} from '../src/main/tsnet-host.js';

describe('parseTsnetLine: the four lines of the sidecar contract', () => {
  it('needs_login', () => {
    expect(parseTsnetLine('{"type":"needs_login","authUrl":"https://login.tailscale.com/a/abc123"}')).toEqual({
      type: 'needs_login',
      authUrl: 'https://login.tailscale.com/a/abc123',
    });
  });

  it('running', () => {
    expect(
      parseTsnetLine(
        '{"type":"running","dnsName":"nanachi-office-pc.tail1234.ts.net","tailnet":"user@example.com","ips":["100.64.0.5","fd7a:115c:a1e0::5"]}',
      ),
    ).toEqual({
      type: 'running',
      dnsName: 'nanachi-office-pc.tail1234.ts.net',
      tailnet: 'user@example.com',
      ips: ['100.64.0.5', 'fd7a:115c:a1e0::5'],
    });
  });

  it('stopped', () => {
    expect(parseTsnetLine('{"type":"stopped"}')).toEqual({ type: 'stopped' });
  });

  it('error', () => {
    expect(parseTsnetLine('{"type":"error","message":"listen tcp :443: bind"}')).toEqual({
      type: 'error',
      message: 'listen tcp :443: bind',
    });
  });

  it.each([
    ['not JSON', 'tsnet: starting'],
    ['an array', '[]'],
    ['an unknown type', '{"type":"ready"}'],
    ['no type', '{"authUrl":"https://x.example"}'],
    ['a needs_login without a URL', '{"type":"needs_login"}'],
    ['a javascript: URL', '{"type":"needs_login","authUrl":"javascript:alert(1)"}'],
    ['an http URL', '{"type":"needs_login","authUrl":"http://login.tailscale.com/a/x"}'],
    ['a running without a dns name', '{"type":"running","dnsName":"","tailnet":"t","ips":[]}'],
    ['a running with non-string ips', '{"type":"running","dnsName":"a.ts.net","tailnet":"t","ips":[1]}'],
    ['an error without a message', '{"type":"error"}'],
  ])('ignores %s', (_label, line) => {
    expect(parseTsnetLine(line)).toBeNull();
  });
});

describe('statusFromEvent', () => {
  it('maps every event to the panel status', () => {
    expect(statusFromEvent({ type: 'needs_login', authUrl: 'https://a.example' })).toEqual({
      state: 'needs_login',
      authUrl: 'https://a.example',
    });
    expect(statusFromEvent({ type: 'running', dnsName: 'a.ts.net', tailnet: 't', ips: ['1.2.3.4'] })).toEqual({
      state: 'running',
      dnsName: 'a.ts.net',
      tailnet: 't',
      ips: ['1.2.3.4'],
    });
    expect(statusFromEvent({ type: 'stopped' })).toEqual({ state: 'off' });
    expect(statusFromEvent({ type: 'error', message: 'boom' })).toEqual({ state: 'error', message: 'boom' });
  });
});

describe('tsnetHostname and sidecarArgs', () => {
  it('builds nanachi-<pc name> with only [a-z0-9-]', () => {
    expect(tsnetHostname('OFFICE-PC')).toBe('nanachi-office-pc');
    expect(tsnetHostname('Desktop do João_01')).toBe('nanachi-desktop-do-jo-o-01');
    expect(tsnetHostname('--weird  name--')).toBe('nanachi-weird-name');
    expect(tsnetHostname('')).toBe('nanachi');
    expect(tsnetHostname('___')).toBe('nanachi');
    expect(tsnetHostname('a'.repeat(100))).toMatch(/^nanachi-a{40}$/);
  });

  it('passes the three flags of the contract', () => {
    expect(
      sidecarArgs({ stateDir: 'C:\\Users\\user\\.nanachi-remote\\tsnet', hostname: 'nanachi-office-pc', target: 'http://127.0.0.1:7777' }),
    ).toEqual([
      '--state-dir',
      'C:\\Users\\user\\.nanachi-remote\\tsnet',
      '--hostname',
      'nanachi-office-pc',
      '--target',
      'http://127.0.0.1:7777',
    ]);
  });
});

describe('resolveSidecarPath', () => {
  const base = { resourcesPath: 'C:\\Nanachi\\resources', buildDir: 'C:\\Users\\user\\AppData\\Local\\nanachi-desktop-build' };

  it('packaged: resources\\bin\\nanachi-tsnet.exe', () => {
    expect(resolveSidecarPath({ ...base, packaged: true, env: {} })).toBe(join(base.resourcesPath, 'bin', SIDECAR_EXE_NAME));
  });

  it('development: <build dir>\\stage\\bin\\nanachi-tsnet.exe, outside the repo', () => {
    expect(resolveSidecarPath({ ...base, packaged: false, env: {} })).toBe(join(base.buildDir, 'stage', 'bin', SIDECAR_EXE_NAME));
  });

  it('development: the env override points at a fake sidecar', () => {
    expect(SIDECAR_EXE_ENV).toBe('NANACHI_DESKTOP_TSNET_PATH');
    expect(resolveSidecarPath({ ...base, packaged: false, env: { [SIDECAR_EXE_ENV]: 'C:\\fake\\fake-tsnet.exe' } })).toBe(
      'C:\\fake\\fake-tsnet.exe',
    );
    expect(resolveSidecarPath({ ...base, packaged: false, env: { [SIDECAR_EXE_ENV]: '' } })).toBe(
      join(base.buildDir, 'stage', 'bin', SIDECAR_EXE_NAME),
    );
  });

  it('an installed Nanachi ignores the override', () => {
    expect(resolveSidecarPath({ ...base, packaged: true, env: { [SIDECAR_EXE_ENV]: 'C:\\evil\\x.exe' } })).toBe(
      join(base.resourcesPath, 'bin', SIDECAR_EXE_NAME),
    );
  });
});

describe('createLineSplitter', () => {
  function collect(maxLineChars?: number): { lines: string[]; push(text: string): void; flush(): void } {
    const lines: string[] = [];
    const splitter = createLineSplitter((line) => lines.push(line), maxLineChars);
    return { lines, push: splitter.push, flush: splitter.flush };
  }

  it('joins a line split across chunks and splits several lines in one chunk', () => {
    const s = collect();
    s.push('{"type":"sto');
    expect(s.lines).toEqual([]);
    s.push('pped"}\n{"type":"a"}\n{"ty');
    expect(s.lines).toEqual(['{"type":"stopped"}', '{"type":"a"}']);
    s.push('pe":"b"}\n');
    expect(s.lines).toEqual(['{"type":"stopped"}', '{"type":"a"}', '{"type":"b"}']);
  });

  it('accepts CRLF and keeps blank lines (the host skips them)', () => {
    const s = collect();
    s.push('one\r\n\r\ntwo\r\n');
    expect(s.lines).toEqual(['one', '', 'two']);
  });

  it('flush emits a last line that has no newline', () => {
    const s = collect();
    s.push('tail');
    s.flush();
    expect(s.lines).toEqual(['tail']);
    s.flush();
    expect(s.lines).toEqual(['tail']);
  });

  it('drops a line longer than the limit, up to the next newline, and keeps going', () => {
    const s = collect(10);
    s.push('x'.repeat(30));
    s.push('yyy\nok\n');
    expect(s.lines).toEqual(['ok']);
  });
});

// ---- the host, with an injected spawn and a fake process ----

class FakeStdin extends EventEmitter {
  ended = false;
  constructor(private readonly onEnd: () => void) {
    super();
  }
  end(): void {
    this.ended = true;
    this.onEnd();
  }
}

class FakeSidecar extends EventEmitter implements TsnetChild {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: FakeStdin;
  readonly signals: Array<NodeJS.Signals | undefined> = [];
  /** A well-behaved sidecar exits when its stdin closes. Turn off to simulate one that hangs. */
  exitOnStdinEnd = true;

  constructor(readonly pid: number | undefined) {
    super();
    this.stdin = new FakeStdin(() => {
      if (this.exitOnStdinEnd) this.exit(0);
    });
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
  /** One stdout line, as the sidecar writes it. */
  say(event: unknown): void {
    this.stdout.emit('data', Buffer.from(`${typeof event === 'string' ? event : JSON.stringify(event)}\n`));
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

const EXE = 'C:\\Users\\user\\AppData\\Local\\nanachi-desktop-build\\stage\\bin\\nanachi-tsnet.exe';
const STATE_DIR = 'C:\\Users\\user\\.nanachi-remote\\tsnet';
const AUTH_URL = 'https://login.tailscale.com/a/secret-token';
const RUNNING = { type: 'running', dnsName: 'nanachi-office-pc.tail1234.ts.net', tailnet: 'user@example.com', ips: ['100.64.0.5'] } as const;

interface Harness {
  host: TsnetHost;
  children: FakeSidecar[];
  spawnCalls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>;
  killed: number[];
  logged: string[];
  statuses: TailscaleStatus[];
  setExists(value: boolean): void;
  port: { value: number };
}

function harness(overrides: Partial<TsnetHostDeps> = {}): Harness {
  const children: FakeSidecar[] = [];
  const spawnCalls: Harness['spawnCalls'] = [];
  const killed: number[] = [];
  const logged: string[] = [];
  const port = { value: 7811 };
  let exists = true;
  let nextPid = 5000;

  const deps: TsnetHostDeps = {
    exePath: () => EXE,
    exists: () => exists,
    stateDir: STATE_DIR,
    hostname: 'nanachi-office-pc',
    target: () => `http://127.0.0.1:${port.value}`,
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
      const child = new FakeSidecar(nextPid++);
      children.push(child);
      return child;
    },
    killTree: (pid) => {
      killed.push(pid);
      children.find((child) => child.pid === pid)?.exit(1);
      return Promise.resolve();
    },
    log: { append: (text) => logged.push(text) },
    env: { PATH: 'x', TS_NO_LOGS_NO_SUPPORT: 'false' },
    ...overrides,
  };
  const host = createTsnetHost(deps);
  const statuses: TailscaleStatus[] = [];
  host.onStatus((status) => statuses.push(status));
  return {
    host,
    children,
    spawnCalls,
    killed,
    logged,
    statuses,
    port,
    setExists(value) {
      exists = value;
    },
  };
}

function last<T>(items: readonly T[]): T {
  const item = items.at(-1);
  if (item === undefined) throw new Error('empty list');
  return item;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('starting the sidecar', () => {
  it('spawns it with the three flags, the daemon port, TS_NO_LOGS_NO_SUPPORT and an open stdin', async () => {
    const h = harness();
    expect(h.host.status()).toEqual({ state: 'off' });
    expect(h.spawnCalls).toHaveLength(0);

    const status = await h.host.start();

    expect(status).toEqual({ state: 'starting' });
    expect(h.spawnCalls).toHaveLength(1);
    const call = last(h.spawnCalls);
    expect(call.command).toBe(EXE);
    expect(call.args).toEqual(['--state-dir', STATE_DIR, '--hostname', 'nanachi-office-pc', '--target', 'http://127.0.0.1:7811']);
    expect(call.cwd).toBe(dirname(STATE_DIR));
    expect(call.env.TS_NO_LOGS_NO_SUPPORT).toBe('true');
    expect(call.env.PATH).toBe('x');
    expect(last(h.children).stdin.ended).toBe(false);
  });

  it('does nothing until start() is called', () => {
    const h = harness();
    vi.advanceTimersByTime(60_000);
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.statuses).toEqual([]);
  });

  it('start() twice does not start a second sidecar', async () => {
    const h = harness();
    await h.host.start();
    await h.host.start();
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('reads the daemon port again on every start', async () => {
    const h = harness();
    await h.host.start();
    await h.host.stop();
    h.port.value = 7900;
    await h.host.start();
    expect(last(h.spawnCalls).args.at(-1)).toBe('http://127.0.0.1:7900');
  });

  it('a missing sidecar file is an error that is not retried', async () => {
    const h = harness();
    h.setExists(false);
    const status = await h.host.start();

    expect(status.state).toBe('error');
    expect(status.state === 'error' && status.message).toContain(EXE);
    vi.advanceTimersByTime(120_000);
    expect(h.spawnCalls).toHaveLength(0);

    // Turning it off and on again tries once more.
    h.setExists(true);
    await h.host.stop();
    await h.host.start();
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('an exePath that throws is an error, not a crash', async () => {
    const h = harness({
      exePath: () => {
        throw new Error('NANACHI_DESKTOP_BUILD_DIR precisa ser um caminho absoluto');
      },
    });
    const status = await h.host.start();
    expect(status).toEqual({ state: 'error', message: expect.stringContaining('caminho absoluto') as unknown });
    expect(h.spawnCalls).toHaveLength(0);
  });
});

describe('reading the sidecar output', () => {
  it('shows needs_login with the URL, then running with the address', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);

    child.say({ type: 'needs_login', authUrl: AUTH_URL });
    expect(h.host.status()).toEqual({ state: 'needs_login', authUrl: AUTH_URL });

    child.say(RUNNING);
    expect(h.host.status()).toEqual({
      state: 'running',
      dnsName: 'nanachi-office-pc.tail1234.ts.net',
      tailnet: 'user@example.com',
      ips: ['100.64.0.5'],
    });
    expect(h.statuses.map((status) => status.state)).toEqual(['starting', 'needs_login', 'running']);
  });

  it('shows an error line of the sidecar and recovers when it serves again', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);

    child.say({ type: 'error', message: 'HTTPS não está habilitado na tailnet' });
    expect(h.host.status()).toEqual({ state: 'error', message: 'HTTPS não está habilitado na tailnet' });
    child.say(RUNNING);
    expect(h.host.status().state).toBe('running');
  });

  it('puts together lines split across chunks, several lines per chunk and multi-byte characters', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);

    const message = '{"type":"error","message":"não conectou: João"}\n';
    const bytes = Buffer.from(message);
    const cut = bytes.indexOf(Buffer.from('ã')) + 1; // inside the two bytes of "ã"
    child.stdout.emit('data', bytes.subarray(0, cut));
    child.stdout.emit('data', bytes.subarray(cut));
    expect(h.host.status()).toEqual({ state: 'error', message: 'não conectou: João' });

    child.stdout.emit(
      'data',
      Buffer.from(`${JSON.stringify({ type: 'needs_login', authUrl: AUTH_URL })}\r\n${JSON.stringify(RUNNING).slice(0, 20)}`),
    );
    expect(h.host.status().state).toBe('needs_login');
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(RUNNING).slice(20)}\n`));
    expect(h.host.status().state).toBe('running');
  });

  it('ignores lines that are not part of the contract', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);
    child.say('tsnet: starting');
    child.say({ type: 'needs_login', authUrl: 'javascript:alert(1)' });
    child.say({ type: 'mystery' });
    child.say('');
    expect(h.host.status()).toEqual({ state: 'starting' });
    expect(h.logged.filter((line) => line.includes('linha ignorada'))).toHaveLength(3);
  });

  it('does not emit the same status twice (the sidecar repeats running)', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);
    child.say(RUNNING);
    child.say(RUNNING);
    expect(h.statuses.filter((status) => status.state === 'running')).toHaveLength(1);
  });

  it('logs events, stderr and the exit with a [tsnet] prefix, but never the login URL', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);
    child.say({ type: 'needs_login', authUrl: AUTH_URL });
    child.stderr.emit('data', Buffer.from('nanachi-tsnet: algo humano\n'));

    const text = h.logged.join('');
    expect(text).toContain('[tsnet] iniciado');
    expect(text).toContain('[tsnet] precisa entrar na conta do Tailscale');
    expect(text).toContain('[tsnet] stderr: nanachi-tsnet: algo humano');
    expect(text).not.toContain('secret-token');
    expect(h.logged.every((line) => line.startsWith('[tsnet] ') && line.endsWith('\n'))).toBe(true);
  });
});

describe('restarting while the user wants it on', () => {
  it('restarts after 1 s, then 2 s, 5 s, 10 s, 30 s and keeps 30 s', async () => {
    const h = harness();
    await h.host.start();

    const waits = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
    for (const [index, wait] of waits.entries()) {
      last(h.children).exit(1);
      expect(h.host.status().state).toBe('error');
      expect(h.spawnCalls).toHaveLength(index + 1);
      vi.advanceTimersByTime(wait - 1);
      expect(h.spawnCalls).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(h.spawnCalls).toHaveLength(index + 2);
      expect(h.host.status()).toEqual({ state: 'starting' });
    }
  });

  it('tells the panel why and when: the sidecar error line, else the exit reason', async () => {
    const h = harness();
    await h.host.start();

    last(h.children).exit(1);
    expect(h.host.status()).toEqual({
      state: 'error',
      message: 'O Tailscale embutido parou (código 1). Tentando de novo em 1 s.',
    });

    vi.advanceTimersByTime(1_000);
    last(h.children).say({ type: 'error', message: 'não consegui falar com o controle' });
    last(h.children).exit(1);
    expect(h.host.status()).toEqual({
      state: 'error',
      message: 'não consegui falar com o controle. Tentando de novo em 2 s.',
    });
  });

  it('a sidecar that ran for 30 s before dying starts the backoff over', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).exit(1);
    vi.advanceTimersByTime(1_000);
    last(h.children).exit(1);
    vi.advanceTimersByTime(2_000);
    expect(h.spawnCalls).toHaveLength(3);

    last(h.children).say(RUNNING);
    vi.advanceTimersByTime(31_000);
    last(h.children).exit(1);
    expect(h.host.status()).toMatchObject({ state: 'error', message: expect.stringContaining('em 1 s') as unknown });
    vi.advanceTimersByTime(1_000);
    expect(h.spawnCalls).toHaveLength(4);
  });

  it('a sidecar that dies right after running keeps backing off', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).say(RUNNING);
    last(h.children).exit(1);
    vi.advanceTimersByTime(1_000);
    last(h.children).say(RUNNING);
    last(h.children).exit(1);
    expect(h.host.status()).toMatchObject({ message: expect.stringContaining('em 2 s') as unknown });
  });

  it('does not restart after exit code 2 (invalid flags), and shows the sidecar message', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).say({ type: 'error', message: 'flag inválida: --target' });
    last(h.children).exit(2);

    expect(h.host.status()).toEqual({ state: 'error', message: 'flag inválida: --target.' });
    vi.advanceTimersByTime(120_000);
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('a spawn that throws is retried with the backoff', async () => {
    let fail = true;
    const h = harness({
      spawn: (command, args, options) => {
        if (fail) throw new Error('spawn EPERM');
        const child = new FakeSidecar(7000);
        h.children.push(child);
        h.spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
        return child;
      },
    });
    await h.host.start();
    expect(h.host.status()).toMatchObject({ state: 'error', message: expect.stringContaining('spawn EPERM') as unknown });

    fail = false;
    vi.advanceTimersByTime(1_000);
    expect(h.host.status()).toEqual({ state: 'starting' });
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('a process error event (cannot execute) counts as the process being gone', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).emit('error', new Error('spawn UNKNOWN'));
    expect(h.host.status()).toMatchObject({ state: 'error', message: expect.stringContaining('spawn UNKNOWN') as unknown });
    vi.advanceTimersByTime(1_000);
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('parses the last line the sidecar wrote before exiting, even when exit comes before close', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);
    child.emit('exit', 1, null);
    child.say({ type: 'error', message: 'não consegui iniciar o nó' });
    child.emit('close', 1, null);
    expect(h.host.status()).toMatchObject({ message: expect.stringContaining('não consegui iniciar o nó') as unknown });
  });

  it('does not wait forever for close after exit', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).emit('exit', 1, null);
    expect(h.host.status()).toEqual({ state: 'starting' });
    vi.advanceTimersByTime(1_000);
    expect(h.host.status().state).toBe('error');
    vi.advanceTimersByTime(1_000);
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('a stopped line alone changes nothing: the exit decides', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).say(RUNNING);
    last(h.children).say({ type: 'stopped' });
    expect(h.host.status().state).toBe('running');
    last(h.children).exit(0);
    expect(h.host.status().state).toBe('error');
  });
});

describe('stopping', () => {
  it('closes stdin, waits for the exit and reports off, without killing', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);
    child.say(RUNNING);

    const status = await h.host.stop();

    expect(child.stdin.ended).toBe(true);
    expect(h.killed).toEqual([]);
    expect(status).toEqual({ state: 'off' });
    expect(h.host.status()).toEqual({ state: 'off' });
    vi.advanceTimersByTime(120_000);
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('kills the process tree when the sidecar does not exit after stdin closes', async () => {
    const h = harness({ gracefulStopMs: 3_000 });
    await h.host.start();
    const child = last(h.children);
    child.exitOnStdinEnd = false;

    const stopping = h.host.stop();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopping).resolves.toEqual({ state: 'off' });
    expect(h.killed).toEqual([child.pid]);
  });

  it('gives up waiting when even the kill does not end it, and still reports off', async () => {
    const h = harness({
      killTree: (pid) => {
        h.killed.push(pid);
        return Promise.resolve();
      },
    });
    await h.host.start();
    last(h.children).exitOnStdinEnd = false;

    const stopping = h.host.stop();
    await vi.advanceTimersByTimeAsync(3_000 + 3_000);
    await expect(stopping).resolves.toEqual({ state: 'off' });
    expect(h.killed).toHaveLength(1);
  });

  it('cancels a pending restart', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).exit(1);
    expect(h.host.status().state).toBe('error');

    await h.host.stop();
    vi.advanceTimersByTime(120_000);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.host.status()).toEqual({ state: 'off' });
  });

  it('events that arrive after stop do not change the status', async () => {
    const h = harness();
    await h.host.start();
    const child = last(h.children);
    child.exitOnStdinEnd = false;
    const stopping = h.host.stop();
    child.say(RUNNING);
    child.say({ type: 'error', message: 'late' });
    child.exit(0);
    await stopping;
    child.say(RUNNING);
    expect(h.host.status()).toEqual({ state: 'off' });
    expect(h.statuses.map((status) => status.state)).toEqual(['starting', 'off']);
  });

  it('stop() when nothing runs is off and harmless', async () => {
    const h = harness();
    expect(await h.host.stop()).toEqual({ state: 'off' });
    expect(h.killed).toEqual([]);
  });

  it('start() right after stop() waits for the old process and starts a new one', async () => {
    const h = harness({ gracefulStopMs: 3_000 });
    await h.host.start();
    const first = last(h.children);
    first.exitOnStdinEnd = false;

    const stopping = h.host.stop();
    const starting = h.host.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawnCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await stopping;
    await expect(starting).resolves.toEqual({ state: 'starting' });
    expect(h.spawnCalls).toHaveLength(2);
    expect(last(h.children)).not.toBe(first);
  });

  it('can be turned on again after a stop', async () => {
    const h = harness();
    await h.host.start();
    await h.host.stop();
    await h.host.start();
    expect(h.spawnCalls).toHaveLength(2);
    expect(h.host.status()).toEqual({ state: 'starting' });
  });
});

describe('dispose (Desktop is quitting)', () => {
  it('stops the sidecar through its stdin and reports off', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).say(RUNNING);

    await h.host.dispose();

    expect(last(h.children).stdin.ended).toBe(true);
    expect(h.killed).toEqual([]);
    expect(h.host.status()).toEqual({ state: 'off' });
  });

  it('kills the tree of a sidecar that ignores the stdin shutdown', async () => {
    const h = harness({ gracefulStopMs: 1_000 });
    await h.host.start();
    const child = last(h.children);
    child.exitOnStdinEnd = false;

    const disposing = h.host.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    await disposing;
    expect(h.killed).toEqual([child.pid]);
  });
});

describe('retarget (the daemon moved to another port)', () => {
  it('restarts a running sidecar with the new --target', async () => {
    const h = harness();
    await h.host.start();
    const first = last(h.children);
    first.say(RUNNING);

    h.port.value = 7900;
    await h.host.retarget();

    expect(first.stdin.ended).toBe(true);
    expect(h.spawnCalls).toHaveLength(2);
    expect(last(h.spawnCalls).args.at(-1)).toBe('http://127.0.0.1:7900');
    expect(h.host.status()).toEqual({ state: 'starting' });
    expect(h.logged.join('')).toMatch(/a porta do daemon mudou/);
  });

  it('does nothing while the port is the same, and does not restart twice for one change', async () => {
    const h = harness();
    await h.host.start();
    await h.host.retarget();
    expect(h.spawnCalls).toHaveLength(1);

    h.port.value = 7900;
    await h.host.retarget();
    await h.host.retarget();
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('does nothing when the sidecar is off or was never started', async () => {
    const h = harness();
    h.port.value = 7900;
    await h.host.retarget();
    expect(h.spawnCalls).toHaveLength(0);

    await h.host.start();
    await h.host.stop();
    h.port.value = 8000;
    await h.host.retarget();
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.host.status()).toEqual({ state: 'off' });
  });

  it('a stop() during the restart wins: no sidecar is started afterwards', async () => {
    const h = harness({ gracefulStopMs: 1_000 });
    await h.host.start();
    last(h.children).exitOnStdinEnd = false;

    h.port.value = 7900;
    const retargeting = h.host.retarget();
    const stopping = h.host.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([retargeting, stopping]);

    expect(h.spawnCalls).toHaveLength(1);
    expect(h.host.status()).toEqual({ state: 'off' });
  });

  it('a sidecar waiting to restart after a crash picks the new port up by itself', async () => {
    const h = harness();
    await h.host.start();
    last(h.children).exit(1);
    h.port.value = 7900;
    await h.host.retarget();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.spawnCalls).toHaveLength(2);
    expect(last(h.spawnCalls).args.at(-1)).toBe('http://127.0.0.1:7900');
  });
});
