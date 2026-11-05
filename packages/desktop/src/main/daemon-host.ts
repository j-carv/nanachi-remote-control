import type { EventEmitter } from 'node:events';
import { messageOf } from '../common/message.js';
import type { DaemonStatus } from '../common/types.js';
import type { DaemonRuntime } from './daemon-runtime.js';
import type { RotatingLog } from './log-file.js';
import type { HealthProbe } from './system.js';

/** What `/api/health` of a Nanachi daemon answers. */
export interface HealthInfo {
  machineId: string;
  machineName: string;
  version: string;
}

/** The part of `ChildProcess` the host uses; tests provide an `EventEmitter` fake. */
export interface ChildLike extends EventEmitter {
  readonly pid?: number | undefined;
  readonly stdout: EventEmitter | null;
  readonly stderr: EventEmitter | null;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface DaemonHostDeps {
  /** Desktop's own data folder; the daemon gets it as its `NANACHI_HOME`. */
  home: string;
  runtime: DaemonRuntime;
  /** Port from config.json, read again on every (re)start. */
  readPort(): number;
  /**
   * Creates `<home>/config.json` with Desktop's default port when it is missing (`ensureDesktopConfig`). Called before
   * every spawn, never when attaching. It throws when the folder cannot be written: without it the daemon would make its
   * own config with port 7777, the standalone daemon's.
   */
  ensureConfig(home: string): void;
  /** What answers on the port: a healthy daemon, one that refuses local calls, or nothing Nanachi. */
  health(port: number): Promise<HealthProbe>;
  spawn(command: string, args: string[], options: SpawnOptions): ChildLike;
  /** Kills the process and everything it started (`taskkill /T /F`). */
  killTree(pid: number): Promise<void>;
  log: RotatingLog;
  /** A runtime file that is not on disk, or null. Checked only before spawning. */
  missingFile(runtime: DaemonRuntime): string | null;
  /**
   * True when nothing listens on the port, so a spawned daemon can bind it. Checked before every spawn: a port held by
   * another program is reported as such instead of becoming a crash loop of daemons that die with EADDRINUSE.
   */
  portFree?(port: number): Promise<boolean>;
  /** Wait between the checks of `portFree` (a daemon that was just killed may take a moment to give the port back). */
  portRecheckMs?: number;
  /** While attached to a daemon Desktop did not start, how often `/api/health` is probed again. 0 turns it off. */
  attachedProbeMs?: number;
  /** Consecutive probes without an answer before Desktop stops trusting the attached daemon and takes over. */
  attachedMisses?: number;
  env?: NodeJS.ProcessEnv;
  /** Wait for a polite exit before killing the tree. 0 skips straight to the kill (Windows has no polite signal). */
  gracefulStopMs?: number;
  /** How long a spawned daemon may take to answer `/api/health`. */
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Restart delays by consecutive crash; the last one repeats. */
  backoffMs?: readonly number[];
  /** More crashes than this inside `crashWindowMs` and Desktop stops trying. */
  maxCrashes?: number;
  crashWindowMs?: number;
}

const DEFAULT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];
const ATTACHED_PROBE_MS = 10_000;
const ATTACHED_MISSES = 3;
const PORT_CHECKS = 3;
const PORT_RECHECK_MS = 300;
const PORT_BUSY_RETRY_MS = 15_000;
const LOG_TAIL_LINES = 20;

/** Shown when a daemon is up but its `allowedTailscaleLogins` makes it refuse every call from this PC. */
export const RESTRICTED_MESSAGE =
  'O daemon responde, mas só aceita acessos pelo Tailscale (allowedTailscaleLogins preenchido no config.json da pasta de dados do Desktop, .nanachi-desktop), ' +
  'então o painel local não consegue usá-lo. Deixe allowedTailscaleLogins vazio nesse config.json para usar o painel, ou abra o endereço do Tailscale.';
/** After `kill`, how long to wait for the exit event before moving on. */
const EXIT_WAIT_MS = 3_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the daemon process for Nanachi Desktop. It never loads the daemon in-process: it either attaches to a
 * daemon that already answers `/api/health` (and then never stops it) or spawns the daemon under a Node 22 and
 * keeps it alive with a backoff, giving up after repeated crashes.
 */
export class DaemonHost {
  private readonly deps: DaemonHostDeps;
  private readonly listeners = new Set<(status: DaemonStatus) => void>();
  private current: DaemonStatus;
  private child: ChildLike | null = null;
  private childExited = true;
  private exitWaiters: Array<() => void> = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private crashTimes: number[] = [];
  /** Bumped on every begin/stop so a late event from an older child or wait loop is ignored. */
  private generation = 0;
  private stopping = false;

  constructor(deps: DaemonHostDeps) {
    this.deps = deps;
    this.current = {
      state: 'stopped',
      port: deps.readPort(),
      mode: 'none',
      pid: null,
      version: null,
      machineName: null,
      restricted: false,
      message: null,
      logTail: [],
    };
  }

  status(): DaemonStatus {
    return { ...this.current, logTail: [...this.current.logTail] };
  }

  port(): number {
    return this.current.port;
  }

  onStatus(listener: (status: DaemonStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Attaches to a daemon that answers, or spawns one. Does nothing while it is already running or attached. */
  async start(): Promise<void> {
    const busy =
      this.current.state === 'running' || this.current.state === 'attached' || this.current.state === 'starting';
    if (busy && !this.stopping) return;
    this.stopping = false;
    this.crashTimes = [];
    await this.begin();
  }

  /** Stops the daemon only when Desktop spawned it; an attached daemon is left alone. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.generation += 1;
    this.clearRestartTimer();
    this.clearWatchTimer();

    const child = this.child;
    const pid = child?.pid;
    if (child !== null && pid !== undefined && !this.childExited) {
      const gracefulMs = this.deps.gracefulStopMs ?? 0;
      if (gracefulMs > 0) {
        child.kill('SIGTERM');
        await this.waitForExit(gracefulMs);
      }
      if (!this.childExited) {
        await this.deps.killTree(pid);
        await this.waitForExit(EXIT_WAIT_MS);
      }
    }
    this.child = null;
    this.update({ state: 'stopped', mode: 'none', pid: null, restricted: false, message: null, logTail: [] });
  }

  /** `quiet`: a retry after a failure; the status stays as it is until the new attempt has an answer. */
  private async begin(quiet = false): Promise<void> {
    const generation = ++this.generation;
    this.clearRestartTimer();
    this.clearWatchTimer();
    const port = this.deps.readPort();
    if (quiet) this.update({ port });
    else this.update({ port, state: 'starting', restricted: false, message: null, logTail: [] });

    const existing = await this.deps.health(port);
    if (generation !== this.generation) return;
    if (existing.kind === 'ok') {
      this.update({
        state: 'attached',
        mode: 'attached',
        pid: null,
        version: existing.info.version,
        machineName: existing.info.machineName,
        message: null,
      });
      this.watchAttached(generation, port);
      return;
    }
    if (existing.kind === 'restricted') {
      this.update({
        state: 'attached',
        mode: 'attached',
        pid: null,
        version: null,
        machineName: null,
        restricted: true,
        message: RESTRICTED_MESSAGE,
      });
      this.watchAttached(generation, port);
      return;
    }

    const missing = this.deps.missingFile(this.deps.runtime);
    if (missing !== null) {
      this.fail(`Arquivo do runtime ausente: ${missing}`);
      return;
    }

    const free = await this.portIsFree(port);
    if (generation !== this.generation) return;
    if (!free) {
      this.fail(
        `A porta ${port} está ocupada por outro programa, que não é um daemon do Nanachi. ` +
          `Feche esse programa ou mude "port" no config.json de ${this.deps.home}; o Nanachi tenta de novo sozinho.`,
      );
      // Not a crash loop: one cheap look every so often, in case the program let go of the port (or it was a daemon
      // that was just restarting).
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.begin(true).catch((error: unknown) => this.fail(`falha ao verificar a porta: ${messageOf(error)}`));
      }, PORT_BUSY_RETRY_MS);
      return;
    }

    try {
      this.deps.ensureConfig(this.deps.home);
    } catch (error) {
      this.fail(`Não foi possível preparar o config.json em ${this.deps.home}: ${messageOf(error)}`);
      return;
    }

    this.spawnDaemon(generation, port);
  }

  /** Looks a few times: a daemon that was just killed can take a moment to give the port back. */
  private async portIsFree(port: number): Promise<boolean> {
    const check = this.deps.portFree;
    if (check === undefined) return true;
    for (let attempt = 0; attempt < PORT_CHECKS; attempt += 1) {
      if (await check(port)) return true;
      if (attempt < PORT_CHECKS - 1) await delay(this.deps.portRecheckMs ?? PORT_RECHECK_MS);
    }
    return false;
  }

  /**
   * While attached, the daemon belongs to somebody else (the supervisor, another copy) and can go away. Probe it every
   * few seconds; after a few misses in a row go back to `begin()`, which attaches again if it is back or spawns one
   * when the port is free.
   */
  private watchAttached(generation: number, port: number): void {
    const intervalMs = this.deps.attachedProbeMs ?? ATTACHED_PROBE_MS;
    if (intervalMs <= 0) return;
    const limit = Math.max(1, this.deps.attachedMisses ?? ATTACHED_MISSES);
    let misses = 0;

    const schedule = (): void => {
      this.watchTimer = setTimeout(() => void tick(), intervalMs);
    };
    const tick = async (): Promise<void> => {
      this.watchTimer = null;
      if (generation !== this.generation) return;
      const result = await this.deps.health(port);
      if (generation !== this.generation) return;
      if (result.kind === 'none') {
        misses += 1;
        if (misses >= limit) {
          this.deps.log.append(`[desktop] o daemon existente na porta ${port} parou de responder; assumindo\n`);
          this.begin().catch((error: unknown) => this.fail(`falha ao reiniciar o daemon: ${messageOf(error)}`));
          return;
        }
      } else {
        misses = 0;
        this.refreshAttached(result);
      }
      schedule();
    };
    schedule();
  }

  /** The attached daemon answered again: keep its version, name and restricted flag current (it may have been reloaded). */
  private refreshAttached(result: Exclude<HealthProbe, { kind: 'none' }>): void {
    if (result.kind === 'ok') {
      const { version, machineName } = result.info;
      if (this.current.restricted || this.current.version !== version || this.current.machineName !== machineName) {
        this.update({ version, machineName, restricted: false, message: null });
      }
    } else if (!this.current.restricted) {
      this.update({ version: null, machineName: null, restricted: true, message: RESTRICTED_MESSAGE });
    }
  }

  private spawnDaemon(generation: number, port: number): void {
    const { runtime, home, log } = this.deps;
    this.update({ state: 'starting', mode: 'spawned', pid: null, version: null, machineName: null });

    let child: ChildLike;
    try {
      child = this.deps.spawn(runtime.nodePath, [runtime.daemonMain], {
        cwd: runtime.cwd,
        env: { ...(this.deps.env ?? process.env), NANACHI_HOME: home },
      });
    } catch (error) {
      this.handleExit(generation, `não foi possível iniciar: ${messageOf(error)}`);
      return;
    }

    this.child = child;
    this.childExited = false;
    this.update({ pid: child.pid ?? null });
    log.append(`[desktop] daemon iniciado (pid ${child.pid ?? '?'}, porta ${port})\n`);

    const onData = (chunk: Buffer | string): void => log.append(chunk.toString());
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    let exitSeen = false;
    const onExit = (reason: string): void => {
      if (exitSeen) return;
      exitSeen = true;
      this.childExited = true;
      const waiters = this.exitWaiters;
      this.exitWaiters = [];
      for (const wake of waiters) wake();
      if (generation !== this.generation || this.stopping) return;
      this.handleExit(generation, reason);
    };
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      onExit(signal !== null ? `sinal ${signal}` : `código ${code ?? '?'}`);
    });
    child.on('error', (error: Error) => {
      onExit(`erro no processo: ${error.message}`);
    });

    void this.waitUntilHealthy(generation, port, child);
  }

  /** Polls `/api/health` until the spawned daemon answers. A silent daemon past the timeout is killed and retried. */
  private async waitUntilHealthy(generation: number, port: number, child: ChildLike): Promise<void> {
    const timeoutMs = this.deps.startupTimeoutMs ?? 60_000;
    const intervalMs = this.deps.pollIntervalMs ?? 250;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (generation !== this.generation || this.childExited) return;
      const probe = await this.deps.health(port);
      if (generation !== this.generation || this.childExited) return;
      if (probe.kind === 'ok') {
        this.update({ state: 'running', version: probe.info.version, machineName: probe.info.machineName, message: null });
        return;
      }
      if (probe.kind === 'restricted') {
        this.update({ state: 'running', restricted: true, message: RESTRICTED_MESSAGE });
        return;
      }
      if (Date.now() >= deadline) {
        this.deps.log.append(`[desktop] o daemon não respondeu em ${Math.round(timeoutMs / 1000)} s; encerrando\n`);
        const pid = child.pid;
        if (pid !== undefined) await this.deps.killTree(pid);
        await this.waitForExit(EXIT_WAIT_MS);
        // The exit event restarts it. If the process refuses to die there is nothing safe left to do.
        if (!this.childExited && generation === this.generation) {
          this.fail('O daemon não respondeu e não pôde ser encerrado.');
        }
        return;
      }
      await delay(intervalMs);
    }
  }

  private handleExit(generation: number, reason: string): void {
    if (generation !== this.generation) return;
    this.child = null;
    this.deps.log.append(`[desktop] o daemon caiu (${reason})\n`);

    const windowMs = this.deps.crashWindowMs ?? 120_000;
    const maxCrashes = this.deps.maxCrashes ?? 5;
    const now = Date.now();
    this.crashTimes = [...this.crashTimes.filter((at) => now - at < windowMs), now];

    if (this.crashTimes.length > maxCrashes) {
      this.fail(
        `O daemon caiu ${this.crashTimes.length} vezes em ${Math.round(windowMs / 60_000)} minutos; o Nanachi parou de tentar. ` +
          `Último motivo: ${reason}.`,
      );
      return;
    }

    const backoff = this.deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    const wait = backoff[Math.min(this.crashTimes.length - 1, backoff.length - 1)] ?? 10_000;
    this.update({
      state: 'starting',
      mode: 'spawned',
      pid: null,
      message: `O daemon caiu (${reason}); tentando de novo em ${Math.round(wait / 1000)} s.`,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.begin().catch((error: unknown) => this.fail(`falha ao reiniciar o daemon: ${messageOf(error)}`));
    }, wait);
  }

  private fail(message: string): void {
    this.update({
      state: 'error',
      mode: 'none',
      pid: null,
      restricted: false,
      message,
      logTail: this.deps.log.tail(LOG_TAIL_LINES),
    });
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

  private clearWatchTimer(): void {
    if (this.watchTimer !== null) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private update(patch: Partial<DaemonStatus>): void {
    this.current = { ...this.current, ...patch };
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }
}
