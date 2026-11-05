import type { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { messageOf } from '../common/message.js';
import type { TailscaleStatus } from '../common/types.js';
import { stageDirOf } from './build-dir.js';
import type { ChildLike, SpawnOptions } from './daemon-host.js';

/**
 * Contract with the Go sidecar `nanachi-tsnet.exe` (`packages/desktop/tsnet`). The sidecar prints one JSON object
 * per line on stdout; these are the four shapes, exactly as in the Desktop contract.
 */
export type TsnetEvent =
  | { type: 'needs_login'; authUrl: string }
  | { type: 'running'; dnsName: string; tailnet: string; ips: string[] }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parses one stdout line of the sidecar. Anything that is not one of the four shapes is null (never thrown). */
export function parseTsnetLine(line: string): TsnetEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;

  switch (record.type) {
    case 'needs_login': {
      // The URL becomes a link in the panel: only https is accepted.
      const { authUrl } = record;
      return typeof authUrl === 'string' && isHttpsUrl(authUrl) ? { type: 'needs_login', authUrl } : null;
    }
    case 'running': {
      const { dnsName, tailnet, ips } = record;
      if (typeof dnsName !== 'string' || dnsName === '' || typeof tailnet !== 'string') return null;
      if (!Array.isArray(ips) || !ips.every((ip): ip is string => typeof ip === 'string')) return null;
      return { type: 'running', dnsName, tailnet, ips };
    }
    case 'stopped':
      return { type: 'stopped' };
    case 'error':
      return typeof record.message === 'string' ? { type: 'error', message: record.message } : null;
    default:
      return null;
  }
}

/** What the panel shows for a sidecar event. */
export function statusFromEvent(event: TsnetEvent): TailscaleStatus {
  switch (event.type) {
    case 'needs_login':
      return { state: 'needs_login', authUrl: event.authUrl };
    case 'running':
      return { state: 'running', dnsName: event.dnsName, tailnet: event.tailnet, ips: event.ips };
    case 'stopped':
      return { state: 'off' };
    case 'error':
      return { state: 'error', message: event.message };
  }
}

/** `nanachi-<pc name, lowercase, [a-z0-9-]>`: the node name the sidecar registers on the tailnet. */
export function tsnetHostname(pcName: string): string {
  const slug = pcName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'nanachi' : `nanachi-${slug}`;
}

export interface SidecarLaunch {
  /** `<Desktop data folder>\tsnet`. */
  stateDir: string;
  hostname: string;
  /** `http://127.0.0.1:<daemon port>`. */
  target: string;
}

/** Command-line flags of the sidecar. */
export function sidecarArgs(launch: SidecarLaunch): string[] {
  return ['--state-dir', launch.stateDir, '--hostname', launch.hostname, '--target', launch.target];
}

export const SIDECAR_EXE_NAME = 'nanachi-tsnet.exe';

/**
 * Test and smoke runs point Desktop at a fake sidecar with this variable (the real one would register a device on the
 * maintainer's tailnet). Only an unpackaged Desktop (`electron .`) honors it; an installed Nanachi ignores it.
 */
export const SIDECAR_EXE_ENV = 'NANACHI_DESKTOP_TSNET_PATH';

export interface SidecarPathInput {
  packaged: boolean;
  /** `process.resourcesPath`: the packaged sidecar is `resources\bin\nanachi-tsnet.exe`. */
  resourcesPath: string;
  /** `%LOCALAPPDATA%\nanachi-desktop-build` (see `build-dir.ts`): development uses `<buildDir>\stage\bin`. */
  buildDir: string;
  env: NodeJS.ProcessEnv;
}

/** Where `nanachi-tsnet.exe` is: next to the app when packaged, in the build folder's stage when developing. */
export function resolveSidecarPath(input: SidecarPathInput): string {
  if (input.packaged) return join(input.resourcesPath, 'bin', SIDECAR_EXE_NAME);
  const override = input.env[SIDECAR_EXE_ENV];
  if (override !== undefined && override !== '') return override;
  return join(stageDirOf(input.buildDir), 'bin', SIDECAR_EXE_NAME);
}

/** The embedded Tailscale node as the rest of Desktop sees it. */
export interface TsnetHost {
  status(): TailscaleStatus;
  /** Starts the sidecar (only when the user turned "Tailscale embutido" on). Resolves with the status right after. */
  start(): Promise<TailscaleStatus>;
  /** Stops the sidecar and its restarts; resolves once the process is gone. */
  stop(): Promise<TailscaleStatus>;
  onStatus(listener: (status: TailscaleStatus) => void): () => void;
  /** Stops the sidecar when Desktop quits. It does not touch the persisted setting. */
  dispose(): Promise<void>;
  /**
   * The daemon may have moved to another port. When the sidecar is running with a `--target` that is no longer the
   * daemon's, it is restarted so it proxies to the right place. Does nothing when it is off or already pointing there.
   */
  retarget(): Promise<void>;
}

/** The part of the sidecar's stdin the host uses. Closing it is the polite shutdown request. */
export interface StdinLike extends EventEmitter {
  end(): void;
}

/** A spawned sidecar. Its stdin is a pipe that stays open: EOF on it stops the sidecar. */
export interface TsnetChild extends ChildLike {
  readonly stdin: StdinLike | null;
}

export type SpawnSidecar = (command: string, args: string[], options: SpawnOptions) => TsnetChild;

export interface TsnetHostDeps {
  /** Path of `nanachi-tsnet.exe`, resolved on every (re)start. */
  exePath(): string;
  exists(path: string): boolean;
  /** `<Desktop data folder>\tsnet`. */
  stateDir: string;
  /** `nanachi-<pc name>`. */
  hostname: string;
  /** `http://127.0.0.1:<port>`, read on every (re)start because the daemon's port can change. */
  target(): string;
  spawn: SpawnSidecar;
  /** Kills the process and everything it started (`taskkill /T /F`). */
  killTree(pid: number): Promise<void>;
  log: { append(text: string): void };
  env?: NodeJS.ProcessEnv;
  /** Restart delays by consecutive crash; the last one repeats. */
  backoffMs?: readonly number[];
  /** After closing stdin, how long to wait for a clean exit before killing the tree. */
  gracefulStopMs?: number;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
const DEFAULT_GRACEFUL_STOP_MS = 3_000;
/** After a kill, how long to wait for the exit event before moving on. */
const EXIT_WAIT_MS = 3_000;
/** A sidecar that stayed `running` this long before it died starts the backoff over. */
const STABLE_RUN_MS = 30_000;
/** After `exit`, how long to wait for `close` (stdout drained) before treating the process as gone anyway. */
const CLOSE_GRACE_MS = 1_000;
/** Exit code of invalid flags: restarting with the same flags cannot help. */
const EXIT_USAGE = 2;
const MAX_LINE_CHARS = 64 * 1024;
const LOG_LINE_CHARS = 300;

/** Splits a text stream into lines (`\n` or `\r\n`). A line longer than `maxLineChars` is dropped. */
export function createLineSplitter(
  onLine: (line: string) => void,
  maxLineChars: number = MAX_LINE_CHARS,
): { push(text: string): void; flush(): void } {
  let buffer = '';
  let dropping = false;
  return {
    push(text) {
      buffer += text;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index === -1) break;
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (dropping) dropping = false;
        else onLine(line);
      }
      if (buffer.length > maxLineChars) {
        buffer = '';
        dropping = true;
      }
    },
    flush() {
      if (!dropping && buffer !== '') onLine(buffer.replace(/\r$/, ''));
      buffer = '';
      dropping = false;
    },
  };
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function clip(text: string): string {
  return text.length > LOG_LINE_CHARS ? `${text.slice(0, LOG_LINE_CHARS)}…` : text;
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  return signal !== null ? `sinal ${signal}` : `código ${code ?? '?'}`;
}

function ignoreError(): void {
  // Closing the stdin of a process that is already gone reports EPIPE; there is nothing to do about it.
}

/**
 * Owns the `nanachi-tsnet.exe` process for Nanachi Desktop. It starts only when the user asked for the embedded
 * Tailscale, turns the sidecar's JSON lines into a status for the panel, restarts it with a backoff when it dies while
 * the user still wants it, and stops it (stdin closed, then the process tree killed) on stop and on quit.
 */
export class SidecarTsnetHost implements TsnetHost {
  private readonly deps: TsnetHostDeps;
  private readonly listeners = new Set<(status: TailscaleStatus) => void>();
  private current: TailscaleStatus = { state: 'off' };
  private enabled = false;
  private child: TsnetChild | null = null;
  private childExited = true;
  private exitWaiters: Array<() => void> = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  /** Bumped on every launch and every stop, so a late event from an older child is ignored. */
  private generation = 0;
  private crashCount = 0;
  private runningSince: number | null = null;
  /** Message of the last `error` line of the current child; it explains a later exit. */
  private lastError: string | null = null;
  /** The `--target` the current child was started with. */
  private launchedTarget: string | null = null;

  constructor(deps: TsnetHostDeps) {
    this.deps = deps;
  }

  status(): TailscaleStatus {
    return this.current;
  }

  onStatus(listener: (status: TailscaleStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<TailscaleStatus> {
    if (this.stopping !== null) await this.stopping;
    // Already on: running, or waiting to restart.
    if (this.enabled && (this.child !== null || this.restartTimer !== null)) return this.current;
    this.enabled = true;
    this.crashCount = 0;
    this.launch();
    return this.current;
  }

  async stop(): Promise<TailscaleStatus> {
    // Before anything else, so a restart in progress (`retarget`) sees the stop and does not launch again.
    this.enabled = false;
    this.generation += 1;
    this.clearRestartTimer();
    this.stopping ??= this.terminate().finally(() => {
      this.stopping = null;
    });
    await this.stopping;
    this.set({ state: 'off' });
    return this.current;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  async retarget(): Promise<void> {
    if (!this.enabled || this.stopping !== null || this.child === null) return;
    const target = this.deps.target();
    if (target === this.launchedTarget) return;
    this.log(`a porta do daemon mudou (${this.launchedTarget ?? '?'} -> ${target}); reiniciando o sidecar`);
    const generation = ++this.generation;
    this.clearRestartTimer();
    this.stopping = this.terminate().finally(() => {
      this.stopping = null;
    });
    await this.stopping;
    if (!this.enabled || generation !== this.generation) return;
    this.crashCount = 0;
    this.launch();
  }

  private launch(): void {
    const generation = ++this.generation;
    this.clearRestartTimer();
    this.runningSince = null;
    this.lastError = null;

    let exe: string;
    try {
      exe = this.deps.exePath();
    } catch (error) {
      this.giveUp(`Não foi possível localizar o Tailscale embutido: ${messageOf(error)}`);
      return;
    }
    if (!this.deps.exists(exe)) {
      this.giveUp(`Não achei o programa do Tailscale embutido (${SIDECAR_EXE_NAME}) em ${exe}.`);
      return;
    }

    this.set({ state: 'starting' });
    let child: TsnetChild;
    const target = this.deps.target();
    try {
      child = this.deps.spawn(
        exe,
        sidecarArgs({ stateDir: this.deps.stateDir, hostname: this.deps.hostname, target }),
        {
          cwd: dirname(this.deps.stateDir),
          // No usage logging or support upload from the embedded node, whatever the parent environment says.
          env: { ...(this.deps.env ?? process.env), TS_NO_LOGS_NO_SUPPORT: 'true' },
        },
      );
    } catch (error) {
      this.onGone(generation, `não foi possível iniciar: ${messageOf(error)}`, null);
      return;
    }

    this.child = child;
    this.childExited = false;
    this.launchedTarget = target;
    this.log(`iniciado (pid ${child.pid ?? '?'}, nó ${this.deps.hostname})`);
    child.stdin?.on('error', ignoreError);

    const stdout = this.readLines(child.stdout, (line) => this.onStdoutLine(generation, line));
    const stderr = this.readLines(child.stderr, (line) => {
      if (generation === this.generation && line.trim() !== '') this.log(`stderr: ${clip(line)}`);
    });

    let finished = false;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (reason: string, code: number | null): void => {
      if (finished) return;
      finished = true;
      if (closeTimer !== null) clearTimeout(closeTimer);
      stdout.flush();
      stderr.flush();
      this.markExited();
      this.onGone(generation, reason, code);
    };
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.markExited();
      // `close` follows once stdout is drained, so the last line (often the reason) is parsed first. A handle that
      // never closes must not hold the restart back.
      closeTimer = setTimeout(() => finish(exitReason(code, signal), code), CLOSE_GRACE_MS);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => finish(exitReason(code, signal), code));
    child.on('error', (error: Error) => finish(`erro no processo: ${error.message}`, null));
  }

  private readLines(stream: EventEmitter | null, onLine: (line: string) => void): { flush(): void } {
    const splitter = createLineSplitter(onLine);
    const decoder = new StringDecoder('utf8');
    stream?.on('data', (chunk: Buffer | string) => {
      splitter.push(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    });
    return {
      flush: () => {
        splitter.push(decoder.end());
        splitter.flush();
      },
    };
  }

  private onStdoutLine(generation: number, line: string): void {
    if (generation !== this.generation || line.trim() === '') return;
    const event = parseTsnetLine(line);
    if (event === null) {
      this.log(`linha ignorada: ${clip(line)}`);
      return;
    }
    switch (event.type) {
      case 'needs_login':
        // The login URL is not logged: it lets whoever opens it add a node to their tailnet.
        this.log('precisa entrar na conta do Tailscale');
        this.set(statusFromEvent(event));
        return;
      case 'running':
        this.log(`rodando em https://${event.dnsName}`);
        this.runningSince = Date.now();
        this.lastError = null;
        this.set(statusFromEvent(event));
        return;
      case 'error':
        this.log(`erro: ${clip(event.message)}`);
        this.lastError = event.message;
        this.set(statusFromEvent(event));
        return;
      case 'stopped':
        // The sidecar is shutting itself down; the exit that follows decides what the panel shows.
        this.log('o sidecar avisou que está parando');
        return;
    }
  }

  /** The process is gone and nobody asked for it (`stop` bumps the generation first). */
  private onGone(generation: number, reason: string, code: number | null): void {
    if (generation !== this.generation) return;
    this.child = null;
    this.log(`processo encerrado (${reason})`);

    const base = this.lastError ?? `O Tailscale embutido parou (${reason})`;
    if (code === EXIT_USAGE) {
      // Invalid flags: the same flags would fail again.
      this.giveUp(sentence(base));
      return;
    }

    if (this.runningSince !== null && Date.now() - this.runningSince >= STABLE_RUN_MS) this.crashCount = 0;
    this.runningSince = null;
    this.crashCount += 1;
    const backoff = this.deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    const wait = backoff[Math.min(this.crashCount - 1, backoff.length - 1)] ?? 30_000;
    this.set({ state: 'error', message: `${sentence(base)} Tentando de novo em ${Math.max(1, Math.round(wait / 1000))} s.` });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, wait);
  }

  /** An error a restart cannot fix: shown as is, with no retry until the user turns the switch off and on. */
  private giveUp(message: string): void {
    this.child = null;
    this.log(message);
    this.set({ state: 'error', message });
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null || this.childExited) return;

    // The sidecar stops on EOF of stdin. If it does not, the whole tree goes.
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    await this.waitForExit(this.deps.gracefulStopMs ?? DEFAULT_GRACEFUL_STOP_MS);
    if (this.childExited) return;

    this.log('não saiu sozinho; encerrando o processo');
    if (child.pid !== undefined) await this.deps.killTree(child.pid);
    else child.kill();
    await this.waitForExit(EXIT_WAIT_MS);
  }

  private markExited(): void {
    this.childExited = true;
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const wake of waiters) wake();
  }

  private waitForExit(ms: number): Promise<void> {
    if (this.childExited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private log(text: string): void {
    this.deps.log.append(`[tsnet] ${text}\n`);
  }

  /** Emits only when the status changed (the sidecar repeats a `running` line after an `error`). */
  private set(next: TailscaleStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}

export function createTsnetHost(deps: TsnetHostDeps): TsnetHost {
  return new SidecarTsnetHost(deps);
}
