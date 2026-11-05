import { StringDecoder } from 'node:string_decoder';
import type { AccountLoginState } from '@nanachi/shared';
import type { AccountCheck } from '../agent-accounts.js';
import { resolveAgentCommand, type AgentCommand } from '../agent-command.js';
import { ApiError } from '../api-error.js';
import { spawnTerminal, type SpawnTerminalOptions, type TerminalProcess } from '../pty-process.js';
import type { AccountAdapter } from './adapters.js';
import { resolveCodexLauncher } from './codex-cli.js';
import { maskCodes, parseLoginOutput, tailOf } from './login-output.js';

/**
 * Login of one account: runs the adapter's login command in a pseudoterminal and follows it from "starting" to a final
 * state (PLAN.md, "Login" under "Routes"). The state lives in memory only. The output and the pasted code are never
 * logged, never persisted, and the code never comes back through the API.
 */

/** Wide enough that the sign-in link never wraps (a wrapped link would be cut at the line break). */
const LOGIN_COLS = 500;
const LOGIN_ROWS = 50;
/** A login that has not finished by then is killed. */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** How long a finished state stays readable. */
export const LOGIN_RETAIN_MS = 10 * 60_000;
/** How long to wait for a killed process to be gone before moving on (it still holds its folder until it exits). */
const KILL_WAIT_MS = 5_000;
/** Cap of the raw output kept in memory. */
const RAW_LIMIT = 200_000;

const MSG_NOT_CONNECTED = 'o login terminou, mas a conta não aparece conectada';
const MSG_NOT_VERIFIABLE = 'o login terminou, mas não foi possível conferir a conta';
const MSG_TIMED_OUT = 'tempo esgotado';
const MSG_PREPARE_FAILED = 'não foi possível preparar a pasta da conta';

type LoginPhase = AccountLoginState['state'];

/** Everything a login needs to know about the account, resolved by the accounts service. */
export interface LoginTarget {
  agentId: string;
  accountId: string;
  adapter: AccountAdapter;
  /** The principal account: nothing to prepare, and the environment carries no home override. */
  principal: boolean;
  /** Working directory of the login process: the account home. */
  cwd: string;
  /** Complete environment of the login process (home override included for a non-principal account). */
  env: NodeJS.ProcessEnv;
}

/** Runs `callback` after `ms` and returns the function that cancels it. Tests pass a manual one. */
export type Schedule = (callback: () => void, ms: number) => () => void;

export interface LoginManagerOptions {
  /** Prepares the profile home of a non-principal account before its process starts (`prepareProfile`). */
  prepare(target: LoginTarget): Promise<void>;
  /** Reads the identity of the account after the login command exited with 0. */
  verify(target: LoginTarget): Promise<AccountCheck>;
  /** The command to run. Default: the adapter's own (`claude auth login`, the bundled `codex login --device-auth`). */
  resolveLogin?: ((adapter: AccountAdapter, target: LoginTarget) => AgentCommand) | undefined;
  /** Starts the pseudoterminal. Default: `spawnTerminal`. */
  spawn?: ((command: AgentCommand, options: SpawnTerminalOptions) => TerminalProcess) | undefined;
  /** Timers. Default: `setTimeout` that does not keep the process alive. */
  schedule?: Schedule | undefined;
  timeoutMs?: number | undefined;
  retainMs?: number | undefined;
  /** Diagnostics only. It never receives anything the login printed or the user pasted. */
  log?: ((message: string) => void) | undefined;
}

/** The part of `LoginManagerOptions` that tests and embedders may replace. */
export type LoginOverrides = Pick<LoginManagerOptions, 'resolveLogin' | 'spawn' | 'schedule' | 'timeoutMs' | 'retainMs'>;

export interface LoginManager {
  /**
   * Starts the login of `target`. The same account already logging in: its running state. Another account of the same
   * agent logging in: 409 `login_in_progress`. A finished state of the same account is replaced.
   */
  start(target: LoginTarget): Promise<AccountLoginState>;
  /** The state of the last login of that account that is still remembered. */
  get(agentId: string, accountId: string): AccountLoginState | undefined;
  /** Types the code into the login process. 404 without a login, 409 `invalid_state` unless it waits for a code. */
  submitCode(agentId: string, accountId: string, code: string): AccountLoginState;
  /** Kills a running login (state `cancelled`). A finished one is left as it is. Undefined when there is none. */
  cancel(agentId: string, accountId: string): Promise<AccountLoginState | undefined>;
  /** Cancels a running login and forgets the account's state (the account is being removed). */
  discard(agentId: string, accountId: string): Promise<void>;
  /** Kills every running login (the daemon is closing). */
  shutdown(): Promise<void>;
}

interface LoginRun {
  readonly key: string;
  readonly target: LoginTarget;
  phase: LoginPhase;
  url: string | null;
  userCode: string | null;
  codeSent: boolean;
  error: string | null;
  account: string | null;
  /** What the process printed, escape sequences included. Dropped when the run finishes. */
  raw: string;
  /** Cleaned (not masked) text of `raw`. Dropped when the run finishes. */
  text: string;
  /** Codes the user pasted, kept only to mask an echo. Dropped when the run finishes. */
  codes: string[];
  /** Output of a finished run: masked and cut to the tail. */
  output: string;
  readonly decoder: StringDecoder;
  process: TerminalProcess | undefined;
  /** Resolves when the process is gone (or never started). */
  readonly exited: Promise<void>;
  markExited(): void;
  cancelTimeout: (() => void) | undefined;
  cancelRetention: (() => void) | undefined;
}

function isFinal(phase: LoginPhase): boolean {
  return phase === 'succeeded' || phase === 'failed' || phase === 'cancelled';
}

function keyOf(agentId: string, accountId: string): string {
  return `${agentId}\u0000${accountId}`;
}

function defaultSchedule(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

/** The adapter's login command: on the agent PATH, or the codex bundled with the daemon. No shell. */
export function resolveLoginCommand(adapter: AccountAdapter, target: LoginTarget): AgentCommand {
  const { login } = adapter;
  if (login.launcher === 'bundled-codex') {
    const launcher = resolveCodexLauncher(target.env);
    return resolveAgentCommand(launcher.file, [...launcher.prefixArgs, ...login.args], target.env);
  }
  return resolveAgentCommand(login.command, login.args, target.env);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLoginManager(options: LoginManagerOptions): LoginManager {
  const resolveLogin = options.resolveLogin ?? resolveLoginCommand;
  const spawn = options.spawn ?? spawnTerminal;
  const schedule = options.schedule ?? defaultSchedule;
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const retainMs = options.retainMs ?? LOGIN_RETAIN_MS;
  const log = options.log ?? (() => undefined);

  const runs = new Map<string, LoginRun>();

  function createRun(target: LoginTarget): LoginRun {
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    return {
      key: keyOf(target.agentId, target.accountId),
      target,
      phase: 'starting',
      url: null,
      userCode: null,
      codeSent: false,
      error: null,
      account: null,
      raw: '',
      text: '',
      codes: [],
      output: '',
      decoder: new StringDecoder('utf8'),
      process: undefined,
      exited,
      markExited,
      cancelTimeout: undefined,
      cancelRetention: undefined,
    };
  }

  function stateOf(run: LoginRun): AccountLoginState {
    const output = isFinal(run.phase) ? run.output : tailOf(maskCodes(run.text, run.codes));
    return {
      accountId: run.target.accountId,
      state: run.phase,
      url: run.url,
      userCode: run.userCode,
      needsCode: run.target.adapter.login.needsCode,
      codeSent: run.codeSent,
      output,
      error: run.error,
      account: run.account,
    };
  }

  /** Re-reads the link and the code from everything printed so far. A value found once is kept. */
  function reparse(run: LoginRun, final: boolean): void {
    const parsed = parseLoginOutput(run.raw, run.target.adapter.login.codePattern, final);
    run.text = parsed.text;
    if (parsed.url !== null) run.url = parsed.url;
    if (parsed.userCode !== null) run.userCode = parsed.userCode;
  }

  function onData(run: LoginRun, chunk: string | Buffer): void {
    if (isFinal(run.phase)) return;
    run.raw += typeof chunk === 'string' ? chunk : run.decoder.write(chunk);
    if (run.raw.length > RAW_LIMIT) run.raw = run.raw.slice(run.raw.length - RAW_LIMIT);
    reparse(run, false);
    if (run.phase === 'starting' && run.url !== null) run.phase = 'waiting';
  }

  /** Moves to a final state: stops the timeout, freezes the (masked) output and forgets raw text and codes. */
  function finish(run: LoginRun, phase: 'succeeded' | 'failed' | 'cancelled', patch: { error?: string; account?: string | null } = {}): void {
    if (isFinal(run.phase)) return;
    run.cancelTimeout?.();
    run.cancelTimeout = undefined;
    reparse(run, true);
    run.output = tailOf(maskCodes(run.text, run.codes));
    run.raw = '';
    run.text = '';
    run.codes = [];
    run.phase = phase;
    run.error = patch.error ?? null;
    run.account = patch.account ?? null;
    run.cancelRetention = schedule(() => {
      if (runs.get(run.key) === run) runs.delete(run.key);
    }, retainMs);
  }

  function kill(run: LoginRun): void {
    try {
      run.process?.kill();
    } catch (error) {
      log(`login ${run.target.agentId}: could not kill the process: ${messageOf(error)}`);
    }
  }

  /** Waits for the process to be gone, but not forever. */
  function waitForExit(run: LoginRun): Promise<void> {
    return new Promise<void>((resolve) => {
      const cancel = schedule(resolve, KILL_WAIT_MS);
      void run.exited.then(() => {
        cancel();
        resolve();
      });
    });
  }

  async function verifyRun(run: LoginRun): Promise<void> {
    let check: AccountCheck;
    try {
      check = await options.verify(run.target);
    } catch (error) {
      log(`login ${run.target.agentId}: account verification failed: ${messageOf(error)}`);
      finish(run, 'failed', { error: MSG_NOT_VERIFIABLE });
      return;
    }
    if (run.phase !== 'verifying') return;
    if (check.status === 'logged_in') finish(run, 'succeeded', { account: check.account });
    else finish(run, 'failed', { error: check.status === 'logged_out' ? MSG_NOT_CONNECTED : MSG_NOT_VERIFIABLE });
  }

  function onExit(run: LoginRun, exitCode: number): void {
    run.markExited();
    if (isFinal(run.phase)) return;
    run.cancelTimeout?.();
    run.cancelTimeout = undefined;
    if (exitCode !== 0) {
      finish(run, 'failed', { error: `o login falhou (código ${exitCode})` });
      return;
    }
    reparse(run, true);
    run.phase = 'verifying';
    void verifyRun(run);
  }

  function failToStart(run: LoginRun, error: unknown): void {
    log(`login ${run.target.agentId}: could not start: ${messageOf(error)}`);
    finish(run, 'failed', { error: `não foi possível iniciar o login: ${messageOf(error)}` });
    run.markExited();
  }

  function activeRunOf(agentId: string): LoginRun | undefined {
    for (const run of runs.values()) {
      if (run.target.agentId === agentId && !isFinal(run.phase)) return run;
    }
    return undefined;
  }

  return {
    async start(target) {
      const key = keyOf(target.agentId, target.accountId);
      const same = runs.get(key);
      if (same !== undefined && !isFinal(same.phase)) return stateOf(same);
      if (activeRunOf(target.agentId) !== undefined) {
        throw new ApiError(409, 'login_in_progress', `a login for ${target.agentId} is already running`);
      }
      same?.cancelRetention?.();

      // Registered before the first await: a second request arriving while the folder is prepared sees this run.
      const run = createRun(target);
      runs.set(key, run);

      if (!target.principal) {
        try {
          await options.prepare(target);
        } catch (error) {
          log(`login ${target.agentId}: preparing the account folder failed: ${messageOf(error)}`);
          finish(run, 'failed', { error: MSG_PREPARE_FAILED });
          run.markExited();
          return stateOf(run);
        }
        if (isFinal(run.phase)) {
          // Cancelled (or the daemon is closing) while the folder was being prepared.
          run.markExited();
          return stateOf(run);
        }
      }

      let terminal: TerminalProcess;
      try {
        const command = resolveLogin(target.adapter, target);
        terminal = spawn(command, { cwd: target.cwd, env: target.env, cols: LOGIN_COLS, rows: LOGIN_ROWS });
      } catch (error) {
        failToStart(run, error);
        return stateOf(run);
      }
      run.process = terminal;
      terminal.onData((chunk) => onData(run, chunk));
      terminal.onExit((exitCode) => onExit(run, exitCode));
      run.cancelTimeout = schedule(() => {
        if (isFinal(run.phase)) return;
        finish(run, 'failed', { error: MSG_TIMED_OUT });
        kill(run);
      }, timeoutMs);
      return stateOf(run);
    },

    get(agentId, accountId) {
      const run = runs.get(keyOf(agentId, accountId));
      return run === undefined ? undefined : stateOf(run);
    },

    submitCode(agentId, accountId, code) {
      const run = runs.get(keyOf(agentId, accountId));
      if (run === undefined) throw new ApiError(404, 'not_found', 'no login for this account');
      if (!run.target.adapter.login.needsCode || run.phase !== 'waiting' || run.process === undefined) {
        throw new ApiError(409, 'invalid_state', `the login is not waiting for a code (${run.phase})`);
      }
      // Remembered before the write: an echo may arrive at once and must already be masked.
      run.codes.push(code);
      try {
        run.process.write(`${code}\r`);
      } catch {
        throw new ApiError(409, 'invalid_state', 'the login process did not accept the code');
      }
      run.codeSent = true;
      return stateOf(run);
    },

    async cancel(agentId, accountId) {
      const run = runs.get(keyOf(agentId, accountId));
      if (run === undefined) return undefined;
      if (!isFinal(run.phase)) {
        finish(run, 'cancelled');
        kill(run);
        await waitForExit(run);
      }
      return stateOf(run);
    },

    async discard(agentId, accountId) {
      const run = runs.get(keyOf(agentId, accountId));
      if (run === undefined) return;
      if (!isFinal(run.phase)) {
        finish(run, 'cancelled');
        kill(run);
        await waitForExit(run);
      }
      run.cancelRetention?.();
      if (runs.get(run.key) === run) runs.delete(run.key);
    },

    async shutdown() {
      const pending = [...runs.values()];
      for (const run of pending) {
        if (!isFinal(run.phase)) {
          finish(run, 'cancelled');
          kill(run);
        }
        run.cancelRetention?.();
      }
      runs.clear();
      await Promise.all(pending.map((run) => waitForExit(run)));
    },
  };
}
