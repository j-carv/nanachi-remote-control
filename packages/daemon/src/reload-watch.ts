import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import { join } from 'node:path';

/** Código de saída que pede reinício ao supervisor (`supervisor.ts`): o build mudou e é hora de recarregar. */
export const RELOAD_EXIT_CODE = 75;
/**
 * Período de silêncio: o reload só acontece quando passaram tantos ms sem nenhuma mudança nas pastas de build
 * (o tsc e o vite escrevem em rajadas). Padrão; o config.json pode trocar (`reloadQuietMs`).
 */
export const RELOAD_QUIET_MS = 60_000;
/** Enquanto há reload pendente, checa de novo se ainda há sessão ativa com este intervalo. */
export const RELOAD_POLL_MS = 2000;

export interface WatchHandle {
  close(): void;
}

export interface ReloadWatchDeps {
  /** Pastas de build observadas (recursivo). */
  dirs: readonly string[];
  /** Sessões que não podem ser interrompidas agora (starting, running, awaiting_permission). */
  busyCount(): number;
  /** Chamado uma vez, quando pode recarregar. Quem chama faz o shutdown limpo e sai com `RELOAD_EXIT_CODE`. */
  reload(): void;
  log(message: string): void;
  /** Impressão digital do build (conteúdo das pastas). Padrão: `fingerprintDirs`. */
  fingerprint?: () => string;
  /** Observa uma pasta. Padrão: `fs.watch` recursivo. */
  watch?: (dir: string, onChange: () => void, onError: (error: Error) => void) => WatchHandle;
  /** Período de silêncio (ms) sem mudanças antes de considerar o build. Padrão: `RELOAD_QUIET_MS`. */
  quietMs?: number;
  pollMs?: number;
}

/** Hash do conteúdo de todos os arquivos das pastas. Reescrever o mesmo conteúdo não muda o hash. */
export function fingerprintDirs(dirs: readonly string[]): string {
  const hash = createHash('sha256');
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
    } catch {
      files = [];
    }
    for (const relative of files) {
      const file = join(dir, relative);
      if (!statSync(file).isFile()) continue;
      hash.update(relative);
      hash.update(readFileSync(file));
    }
  }
  return hash.digest('hex');
}

function defaultWatch(dir: string, onChange: () => void, onError: (error: Error) => void): WatchHandle {
  const watcher = watch(dir, { recursive: true }, () => onChange());
  watcher.on('error', onError);
  return { close: () => watcher.close() };
}

/**
 * Recarrega o daemon quando o build muda (`dist` do daemon e do shared), sem derrubar agente em trabalho.
 * Regras para recarregar: (1) passaram `quietMs` sem nenhuma mudança nas pastas (cada mudança reinicia a conta;
 * a checagem de build acontece no fim do silêncio) e (2) nenhuma sessão está `starting`, `running` ou
 * `awaiting_permission`. Se a (2) falha, reconta a cada `pollMs`, mas só enquanto o silêncio continua.
 * Sessão `idle` não segura o reload: o daemon grava as idle e as retoma sozinho depois de subir.
 */
export class ReloadWatcher {
  private readonly fingerprint: () => string;
  private readonly watchDir: (dir: string, onChange: () => void, onError: (error: Error) => void) => WatchHandle;
  private readonly quietMs: number;
  private readonly pollMs: number;
  private baseline = '';
  private handles: WatchHandle[] = [];
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private pending = false;
  private lastBusy: number | undefined;
  private stopped = false;

  constructor(private readonly deps: ReloadWatchDeps) {
    this.fingerprint = deps.fingerprint ?? (() => fingerprintDirs(deps.dirs));
    this.watchDir = deps.watch ?? defaultWatch;
    this.quietMs = deps.quietMs ?? RELOAD_QUIET_MS;
    this.pollMs = deps.pollMs ?? RELOAD_POLL_MS;
  }

  /** Tira a impressão digital de partida e começa a observar. Pasta que não abre vira aviso no log. */
  start(): void {
    this.baseline = this.fingerprint();
    for (const dir of this.deps.dirs) {
      try {
        this.handles.push(
          this.watchDir(
            dir,
            () => this.onChange(),
            (error) => this.deps.log(`observação de ${dir} falhou: ${error.message}`),
          ),
        );
      } catch (error) {
        this.deps.log(`não observa ${dir}: ${(error as Error).message}`);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.quietTimer);
    clearInterval(this.pollTimer);
    this.quietTimer = undefined;
    this.pollTimer = undefined;
    for (const handle of this.handles) handle.close();
    this.handles = [];
  }

  /** Mudança nova: reinicia o silêncio e para de contar sessões até ele voltar (a checagem vem no fim dele). */
  private onChange(): void {
    if (this.stopped) return;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.evaluate(), this.quietMs);
  }

  /** Fim do silêncio: o build ainda é diferente do de partida? Se sim, fica pendente e tenta recarregar. */
  private evaluate(): void {
    this.quietTimer = undefined;
    if (this.stopped) return;
    const changed = this.fingerprint() !== this.baseline;
    if (!changed) {
      this.pending = false;
      this.lastBusy = undefined;
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      return;
    }
    if (!this.pending) {
      this.pending = true;
      this.deps.log(
        `reload pendente: build novo detectado; recarrega após ${this.quietMs / 1000} s sem mudanças e sem sessão ativa`,
      );
    }
    this.tryReload();
  }

  private tryReload(): void {
    if (this.stopped) return;
    const busy = this.deps.busyCount();
    if (busy === 0) {
      this.stop();
      this.deps.log('recarregando');
      this.deps.reload();
      return;
    }
    if (busy !== this.lastBusy) {
      this.lastBusy = busy;
      this.deps.log(`reload pendente: aguardando ${busy} sessões ativas`);
    }
    if (this.pollTimer === undefined) {
      this.pollTimer = setInterval(() => this.tryReload(), this.pollMs);
    }
  }
}
