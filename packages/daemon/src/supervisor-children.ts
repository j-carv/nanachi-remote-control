import { spawn } from 'node:child_process';
import type { KillResult } from './process-tree.js';
import { RELOAD_EXIT_CODE } from './reload-watch.js';
import { RestartPolicy } from './supervisor-policy.js';

export interface ChildSpec {
  /** Nome curto que aparece no log: `[shared-tsc]`, `[daemon]`... */
  name: string;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Visão mínima de um processo filho: o supervisor só precisa da saída, da saída final e do pid. */
export interface ChildHandle {
  readonly pid: number | undefined;
  onOutput(listener: (stream: 'stdout' | 'stderr', chunk: string) => void): void;
  /** `detail` vem quando o processo nem chegou a subir (ex.: ENOENT). */
  onExit(listener: (code: number | null, detail?: string) => void): void;
}

export type SpawnChild = (spec: ChildSpec) => ChildHandle;

export interface ChildLog {
  write(source: string, text: string): void;
}

export interface ChildDeps {
  spawn: SpawnChild;
  log: ChildLog;
  killTree(pid: number): KillResult;
}

/** Filho real: `child_process.spawn` sem shell, sem janela, stdin fechado, stdout/stderr lidos pelo supervisor. */
export function spawnChildProcess(spec: ChildSpec): ChildHandle {
  const child = spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    pid: child.pid,
    onOutput(listener) {
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => listener('stdout', chunk));
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => listener('stderr', chunk));
    },
    onExit(listener) {
      child.once('exit', (code) => listener(code));
      child.once('error', (error) => listener(null, error.message));
    },
  };
}

/** Quebra um fluxo de texto em linhas completas; o resto fica guardado até a próxima parte. */
class LineBuffer {
  private pending = '';

  push(chunk: string): string[] {
    const parts = `${this.pending}${chunk}`.split('\n');
    this.pending = parts.pop() ?? '';
    return parts;
  }

  flush(): string[] {
    const rest = this.pending;
    this.pending = '';
    return rest === '' ? [] : [rest];
  }
}

/**
 * Um filho mantido vivo: sobe, repassa a saída ao log e reinicia conforme `RestartPolicy`. `stop` mata a árvore
 * e impede qualquer reinício dali em diante.
 */
export class ManagedChild {
  private handle: ChildHandle | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private startedAt = 0;
  private readonly policy = new RestartPolicy();
  private readonly buffers = { stdout: new LineBuffer(), stderr: new LineBuffer() };

  constructor(
    private readonly spec: ChildSpec,
    private readonly deps: ChildDeps,
  ) {}

  start(): void {
    if (this.stopped) return;
    let handle: ChildHandle;
    try {
      handle = this.deps.spawn(this.spec);
    } catch (error) {
      this.exited(undefined, null, (error as Error).message);
      return;
    }
    this.handle = handle;
    this.startedAt = Date.now();
    this.deps.log.write(this.spec.name, `iniciado (pid ${handle.pid ?? 'desconhecido'})`);
    handle.onOutput((stream, chunk) => {
      if (this.handle !== handle) return;
      for (const line of this.buffers[stream].push(chunk)) this.deps.log.write(this.spec.name, line);
    });
    handle.onExit((code, detail) => this.exited(handle, code, detail));
  }

  /** Mata a árvore do filho e não reinicia mais. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const pid = this.handle?.pid;
    if (pid === undefined) return;
    const killed = this.deps.killTree(pid);
    if (!killed.ok) this.deps.log.write(this.spec.name, `não foi possível matar o processo: ${killed.message}`);
    this.deps.log.write(this.spec.name, 'encerrado');
  }

  /** Saída (ou falha de subida). `onExit` pode disparar mais de uma vez: só a primeira conta. */
  private exited(handle: ChildHandle | undefined, code: number | null, detail?: string): void {
    if (handle !== undefined && this.handle !== handle) return;
    if (handle === undefined && this.handle !== undefined) return;
    this.handle = undefined;
    for (const stream of ['stdout', 'stderr'] as const) {
      for (const line of this.buffers[stream].flush()) this.deps.log.write(this.spec.name, line);
    }
    const suffix = detail === undefined ? '' : `: ${detail}`;
    this.deps.log.write(this.spec.name, `saiu (código ${code ?? 'desconhecido'})${suffix}`);
    if (this.stopped) return;

    const delay = this.policy.nextDelay({ code, ranMs: Date.now() - this.startedAt });
    if (delay === 0) {
      this.deps.log.write(this.spec.name, code === RELOAD_EXIT_CODE ? 'reiniciando já (reload)' : 'reiniciando já');
      this.start();
      return;
    }
    this.deps.log.write(this.spec.name, `reiniciando em ${delay / 1000} s`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, delay);
  }
}
