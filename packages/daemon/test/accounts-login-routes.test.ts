import { existsSync, readFileSync } from 'node:fs';
import { lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountLoginStateSchema, AgentAccountsResponseSchema, AgentProfileSchema, type AccountLoginState, type AgentAccount } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { agentBinDirs } from '../src/agent-path.js';
import type { AgentAccountsService, CommandResult, RunCommand } from '../src/agent-accounts.js';
import { LOGIN_RETAIN_MS, LOGIN_TIMEOUT_MS, type Schedule } from '../src/accounts/login.js';
import type { AccountRuntime } from '../src/accounts/service.js';
import { spawnTerminal } from '../src/pty-process.js';
import { authHeader } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/login-fixture.mjs', import.meta.url));
const SAMPLES = JSON.parse(readFileSync(new URL('./fixtures/login-samples.json', import.meta.url), 'utf8')) as {
  claudeUrl: string;
};
const PASTED = 'Zx9Qw-PASTED-CODE-abc123#state456';
const MARKER = 'logged-in.marker';
const LEAK_VAR = 'NANACHI_TEST_LEAK';

const OK = (stdout: string, stderr = ''): CommandResult => ({ code: 0, stdout, stderr });

/** Fake principal: what `GET /api/agents/accounts` reads from it. Records the calls to see who asked for `refresh`. */
function fakePrincipal(): AgentAccountsService & { refreshes: boolean[] } {
  const refreshes: boolean[] = [];
  const accounts: Array<Omit<AgentAccount, 'supportsAccounts' | 'profiles'>> = [
    { agentId: 'claude', label: 'Claude Code', status: 'logged_in', account: 'principal@exemplo.com', detail: null, checkedAt: 1 },
    { agentId: 'codex', label: 'Codex', status: 'logged_out', account: null, detail: null, checkedAt: 1 },
    { agentId: 'omp', label: 'Oh My Pi', status: 'unknown', account: null, detail: 'Sem verificação', checkedAt: 1 },
  ];
  return {
    refreshes,
    list: (options) => {
      refreshes.push(options?.refresh === true);
      return Promise.resolve(accounts);
    },
  };
}

/**
 * `claude auth status` and `codex login status` answer by the profile folder: with the marker, logged in; without it,
 * logged out. No real process.
 */
const fakeRun: RunCommand = (_file, args, options) => {
  const marked = (home: string | undefined): boolean => home !== undefined && existsSync(join(home, MARKER));
  if (args[0] === 'auth') {
    return Promise.resolve(
      marked(options.env.CLAUDE_CONFIG_DIR)
        ? OK(JSON.stringify({ loggedIn: true, email: 'trabalho@exemplo.com' }))
        : OK(JSON.stringify({ loggedIn: false })),
    );
  }
  return Promise.resolve(marked(options.env.CODEX_HOME) ? OK('', 'Logged in using ChatGPT') : OK('', 'Not logged in'));
};

/** Manual clock of the routes: the login timers only fire in `advance`. */
function manualClock(): { schedule: Schedule; advance(ms: number): void } {
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
  };
}

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

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('account login: routes', () => {
  const env = setupDaemonTests();
  const principal = fakePrincipal();
  let mode: string[] = ['claude'];
  let clock = manualClock();

  const outDir = (): string => join(env.home, 'saida-login');
  const principalHome = (): string => join(env.home, 'principal-claude');
  const profileHome = (agentId: string, accountId: string): string => join(env.home, 'accounts', agentId, accountId);

  async function start(extra: Partial<AccountRuntime> = {}): Promise<TestDaemon> {
    mode = ['claude'];
    clock = manualClock();
    const daemonEnv: NodeJS.ProcessEnv = { ...process.env, [LEAK_VAR]: 'segredo-do-daemon', LOGIN_OUT_DIR: outDir() };
    const daemon = await env.start({
      config: {
        agents: {
          claude: { label: 'Claude Code', command: 'claude-agent-acp', env: { CLAUDE_CONFIG_DIR: principalHome() } },
          codex: { label: 'Codex', command: 'codex-acp', env: { CODEX_HOME: join(env.home, 'principal-codex') } },
        },
      },
      agentAccounts: principal,
      accountRuntime: {
        userHome: join(env.home, 'user-home'),
        daemonEnv,
        resolve: () => 'C:\\fake\\agent.exe',
        run: fakeRun,
        login: { resolveLogin: () => ({ file: process.execPath, args: [FIXTURE, ...mode], shell: false }), schedule: clock.schedule },
        ...extra,
      },
    });
    await mkdir(principalHome(), { recursive: true });
    return daemon;
  }

  async function call(daemon: TestDaemon, method: 'GET' | 'POST' | 'DELETE' | 'PUT', url: string, payload?: unknown) {
    return daemon.app.inject({ method, url, headers: await authHeader(daemon), ...(payload === undefined ? {} : { payload: payload as object }) });
  }

  async function createAccount(daemon: TestDaemon, agent: string, label = 'Trabalho'): Promise<string> {
    const res = await call(daemon, 'POST', `/api/agents/${agent}/accounts`, { label });
    expect(res.statusCode).toBe(201);
    return AgentProfileSchema.parse(res.json<unknown>()).id;
  }

  async function loginState(daemon: TestDaemon, agent: string, accountId: string): Promise<AccountLoginState> {
    const res = await call(daemon, 'GET', `/api/agents/${agent}/accounts/${accountId}/login`);
    expect(res.statusCode).toBe(200);
    return AccountLoginStateSchema.parse(res.json<unknown>());
  }

  async function reach(daemon: TestDaemon, agent: string, accountId: string, wanted: AccountLoginState['state']): Promise<AccountLoginState> {
    return waitFor(async () => {
      const state = await loginState(daemon, agent, accountId);
      return state.state === wanted ? state : undefined;
    }, `the login to reach ${wanted}`);
  }

  /** What the fixture process saw (`env.json`, written by it on start). */
  interface SeenByProcess {
    cwd: string;
    columns: number;
    CLAUDE_CONFIG_DIR?: string;
    CODEX_HOME?: string;
    PATH: string;
    NANACHI_TEST_LEAK?: string;
  }
  const seen = (): SeenByProcess => JSON.parse(readFileSync(join(outDir(), 'env.json'), 'utf8')) as SeenByProcess;
  const pidOf = (): number => Number(readFileSync(join(outDir(), 'pid'), 'utf8'));

  describe('invalid requests (no process)', () => {
    it('unknown agent is 404 and an agent without extra accounts is 400, on every login route', async () => {
      const daemon = await start();
      const routes: Array<['GET' | 'POST' | 'DELETE', string, unknown?]> = [
        ['POST', 'login'],
        ['GET', 'login'],
        ['DELETE', 'login'],
        ['POST', 'login/code', { code: 'abc' }],
      ];
      for (const [method, path, payload] of routes) {
        const unknown = await call(daemon, method, `/api/agents/nao-existe/accounts/default/${path}`, payload);
        expect([method, path, unknown.statusCode, unknown.json()]).toEqual([method, path, 404, { error: 'not_found' }]);
        const omp = await call(daemon, method, `/api/agents/omp/accounts/default/${path}`, payload);
        expect([method, path, omp.statusCode, omp.json()]).toEqual([method, path, 400, { error: 'accounts_unsupported' }]);
      }
    });

    it('unknown account of the agent is 404 on every login route', async () => {
      const daemon = await start();
      const routes: Array<['GET' | 'POST' | 'DELETE', string, unknown?]> = [
        ['POST', 'login'],
        ['GET', 'login'],
        ['DELETE', 'login'],
        ['POST', 'login/code', { code: 'abc' }],
      ];
      for (const [method, path, payload] of routes) {
        const res = await call(daemon, method, `/api/agents/claude/accounts/nope/${path}`, payload);
        expect([method, path, res.statusCode, res.json()]).toEqual([method, path, 404, { error: 'not_found' }]);
      }
    });

    it('no login for the account: GET, DELETE and code are 404 not_found', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');

      for (const [method, path, payload] of [
        ['GET', 'login', undefined],
        ['DELETE', 'login', undefined],
        ['POST', 'login/code', { code: 'abc' }],
      ] as const) {
        const res = await call(daemon, method, `/api/agents/claude/accounts/${id}/${path}`, payload);
        expect([method, path, res.statusCode, res.json()]).toEqual([method, path, 404, { error: 'not_found' }]);
      }
    });

    it('invalid code (empty, with control characters, too long, missing) is 400 invalid_request', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      for (const body of [{ code: '' }, { code: 'abc\n' }, { code: 'a\u001b[0m' }, { code: 'a'.repeat(2001) }, {}, { code: 7 }]) {
        const res = await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login/code`, body);
        expect([JSON.stringify(body).slice(0, 30), res.statusCode, res.json()]).toEqual([JSON.stringify(body).slice(0, 30), 400, { error: 'invalid_request' }]);
      }
    });

    it('requires a device Bearer', async () => {
      const daemon = await start();
      for (const [method, path] of [
        ['POST', 'login'],
        ['GET', 'login'],
        ['DELETE', 'login'],
        ['POST', 'login/code'],
      ] as const) {
        const url = `/api/agents/claude/accounts/default/${path}`;
        const res = path === 'login/code' ? await daemon.app.inject({ method, url, payload: { code: 'a' } }) : await daemon.app.inject({ method, url });
        expect([method, path, res.statusCode]).toEqual([method, path, 401]);
      }
    });
  });

  describe.skipIf(!ptyAvailable())('with a fixture login command in a real PTY', () => {
    it('Claude, extra account: POST starts the login, the link shows up, the code goes in, the login ends and the list shows the account', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['claude', 'echo'];
      const before = AgentAccountsResponseSchema.parse((await call(daemon, 'GET', '/api/agents/accounts')).json<unknown>());
      expect(before.accounts.find((a) => a.agentId === 'claude')?.profiles.find((p) => p.id === id)).toMatchObject({ status: 'logged_out' });

      const started = await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      expect(started.statusCode).toBe(200);
      expect(AccountLoginStateSchema.parse(started.json<unknown>())).toMatchObject({ accountId: id, needsCode: true, codeSent: false });

      const waiting = await reach(daemon, 'claude', id, 'waiting');
      expect(waiting).toMatchObject({ url: SAMPLES.claudeUrl, userCode: null });

      const sent = await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login/code`, { code: PASTED });
      expect(sent.statusCode).toBe(200);
      expect(sent.body).not.toContain(PASTED);
      expect(AccountLoginStateSchema.parse(sent.json<unknown>()).codeSent).toBe(true);

      const done = await reach(daemon, 'claude', id, 'succeeded');
      expect(done).toMatchObject({ account: 'trabalho@exemplo.com', error: null, codeSent: true });
      expect(JSON.stringify(done)).not.toContain('PASTED-CODE');
      expect(done.output).toContain('••••');

      // Success drops the identity cache: the list already shows the account, without ?refresh=1.
      const after = AgentAccountsResponseSchema.parse((await call(daemon, 'GET', '/api/agents/accounts')).json<unknown>());
      expect(after.accounts.find((a) => a.agentId === 'claude')?.profiles.find((p) => p.id === id)).toMatchObject({
        status: 'logged_in',
        account: 'trabalho@exemplo.com',
      });
    });

    it('process env and cwd: profile folder, no NANACHI_*, with the agent PATH, 500 columns', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['hang'];

      await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      await reach(daemon, 'claude', id, 'waiting');

      const process_ = seen();
      expect(process_.cwd.toLowerCase()).toBe(profileHome('claude', id).toLowerCase());
      expect(process_.CLAUDE_CONFIG_DIR?.toLowerCase()).toBe(profileHome('claude', id).toLowerCase());
      expect(process_.NANACHI_TEST_LEAK).toBeUndefined();
      expect(process_.columns).toBe(500);
      const binDirs = agentBinDirs();
      expect(binDirs.length).toBeGreaterThan(0);
      expect(process_.PATH.toLowerCase().startsWith((binDirs[0] ?? '').toLowerCase())).toBe(true);
    });

    it('extra account: the profile folder is prepared before the login (junctions created), the principal is not touched', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['hang'];
      // `POST /accounts` already prepared the folder; delete a junction to prove the login prepares it again.
      await rm(join(profileHome('claude', id), 'projects'), { recursive: true });

      await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      await reach(daemon, 'claude', id, 'waiting');

      expect((await lstat(join(profileHome('claude', id), 'projects'))).isSymbolicLink()).toBe(true);
    });

    it('principal account (default): no profile preparation, the agent env from the config, the principal e-mail at the end', async () => {
      const daemon = await start();
      mode = ['claude'];
      principal.refreshes.length = 0;

      const started = await call(daemon, 'POST', '/api/agents/claude/accounts/default/login');
      expect(started.statusCode).toBe(200);
      expect(AccountLoginStateSchema.parse(started.json<unknown>()).accountId).toBe('default');
      await reach(daemon, 'claude', 'default', 'waiting');

      const process_ = seen();
      expect(process_.cwd.toLowerCase()).toBe(principalHome().toLowerCase());
      expect(process_.CLAUDE_CONFIG_DIR?.toLowerCase()).toBe(principalHome().toLowerCase());
      // Nothing was created inside the principal home: not even the shared folders, which belong to a profile preparation.
      expect(existsSync(join(principalHome(), 'projects'))).toBe(false);
      expect(existsSync(join(env.home, 'accounts', 'claude'))).toBe(false);

      await call(daemon, 'POST', '/api/agents/claude/accounts/default/login/code', { code: PASTED });
      const done = await reach(daemon, 'claude', 'default', 'succeeded');
      expect(done.account).toBe('principal@exemplo.com');
      expect(principal.refreshes).toContain(true);
    });

    it('one login per agent: another account of the agent is 409 login_in_progress; the same one returns the running state; another agent goes on', async () => {
      const daemon = await start();
      const first = await createAccount(daemon, 'claude', 'Um');
      const second = await createAccount(daemon, 'claude', 'Dois');
      const codex = await createAccount(daemon, 'codex', 'Codex 2');
      mode = ['hang'];

      expect((await call(daemon, 'POST', `/api/agents/claude/accounts/${first}/login`)).statusCode).toBe(200);
      await reach(daemon, 'claude', first, 'waiting');

      const other = await call(daemon, 'POST', `/api/agents/claude/accounts/${second}/login`);
      expect(other.statusCode).toBe(409);
      expect(other.json()).toEqual({ error: 'login_in_progress' });
      const principalToo = await call(daemon, 'POST', '/api/agents/claude/accounts/default/login');
      expect(principalToo.statusCode).toBe(409);

      const same = await call(daemon, 'POST', `/api/agents/claude/accounts/${first}/login`);
      expect(same.statusCode).toBe(200);
      expect(AccountLoginStateSchema.parse(same.json<unknown>())).toMatchObject({ accountId: first, state: 'waiting' });

      expect((await call(daemon, 'POST', `/api/agents/codex/accounts/${codex}/login`)).statusCode).toBe(200);
    });

    it('Codex: link and code show up; sending a code is 409 invalid_state; on exit 0 the account is checked', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'codex', 'Codex 2');
      mode = ['codex', 'hold'];

      await call(daemon, 'POST', `/api/agents/codex/accounts/${id}/login`);
      const waiting = await reach(daemon, 'codex', id, 'waiting');
      expect(waiting).toMatchObject({ url: 'https://auth.openai.com/codex/device', userCode: '0HKH-0YU99', needsCode: false });

      const code = await call(daemon, 'POST', `/api/agents/codex/accounts/${id}/login/code`, { code: 'abc' });
      expect(code.statusCode).toBe(409);
      expect(code.json()).toEqual({ error: 'invalid_state' });

      await writeFile(join(profileHome('codex', id), 'release'), '');
      const done = await reach(daemon, 'codex', id, 'succeeded');
      // The fake Codex verifier says "Logged in using ChatGPT" without an e-mail (there is no credential to read).
      expect(done).toMatchObject({ account: null, error: null, userCode: '0HKH-0YU99' });
    });

    it('a CLI that exits with 1: GET shows failed "o login falhou (código 1)"', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['fail'];

      await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      const failed = await reach(daemon, 'claude', id, 'failed');

      expect(failed).toMatchObject({ error: 'o login falhou (código 1)', account: null });
      // A new attempt after a failure is allowed.
      mode = ['hang'];
      expect((await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`)).statusCode).toBe(200);
    });

    it('code only in waiting: sending it after the login finished is 409 invalid_state', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['fail'];
      await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      await reach(daemon, 'claude', id, 'failed');

      const res = await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login/code`, { code: 'abc' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'invalid_state' });
    });

    it('DELETE login: 204, state cancelled, the process goes away; repeating is 204; the cancelled state stays readable', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['hang'];
      await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      await reach(daemon, 'claude', id, 'waiting');
      const pid = pidOf();
      expect(alive(pid)).toBe(true);

      const res = await call(daemon, 'DELETE', `/api/agents/claude/accounts/${id}/login`);

      expect(res.statusCode).toBe(204);
      expect((await loginState(daemon, 'claude', id)).state).toBe('cancelled');
      await waitFor(() => (alive(pid) ? undefined : true), 'the process to exit');
      expect((await call(daemon, 'DELETE', `/api/agents/claude/accounts/${id}/login`)).statusCode).toBe(204);
      expect((await loginState(daemon, 'claude', id)).state).toBe('cancelled');
    });

    it('15 minutes without finishing: failed "tempo esgotado" and the process goes away; the final state goes away 10 minutes later', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['hang'];
      await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      await reach(daemon, 'claude', id, 'waiting');
      const pid = pidOf();

      clock.advance(LOGIN_TIMEOUT_MS);

      expect(await loginState(daemon, 'claude', id)).toMatchObject({ state: 'failed', error: 'tempo esgotado' });
      await waitFor(() => (alive(pid) ? undefined : true), 'the process to exit');
      clock.advance(LOGIN_RETAIN_MS);
      const gone = await call(daemon, 'GET', `/api/agents/claude/accounts/${id}/login`);
      expect(gone.statusCode).toBe(404);
    });

    it('DELETE of an account with a running login: cancels the login, waits for the process to exit and removes the folder', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['hang'];
      await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      await reach(daemon, 'claude', id, 'waiting');
      const pid = pidOf();
      const home = profileHome('claude', id);
      // The process has the folder as its cwd: without waiting for it to exit, Windows refuses to delete it.
      expect(seen().cwd.toLowerCase()).toBe(home.toLowerCase());

      const res = await call(daemon, 'DELETE', `/api/agents/claude/accounts/${id}`);

      expect(res.statusCode).toBe(204);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      await waitFor(() => (alive(pid) ? undefined : true), 'the process to exit');
      expect((await call(daemon, 'GET', `/api/agents/claude/accounts/${id}/login`)).statusCode).toBe(404);
    });

    it('closing the daemon kills the running login', async () => {
      const daemon = await start();
      const id = await createAccount(daemon, 'claude');
      mode = ['hang'];
      await call(daemon, 'POST', `/api/agents/claude/accounts/${id}/login`);
      await reach(daemon, 'claude', id, 'waiting');
      const pid = pidOf();

      await daemon.app.close();

      await waitFor(() => (alive(pid) ? undefined : true), 'the process to exit');
    });
  });
});
