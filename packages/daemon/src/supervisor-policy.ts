import { RELOAD_EXIT_CODE } from './reload-watch.js';

/** Espera entre reinícios depois de falhas seguidas: 1 s, 2 s, 5 s, 10 s e depois 30 s para sempre. */
export const RESTART_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10000, 30000];
/** Quanto tempo rodando conta como estável: depois disso a próxima falha volta ao começo do backoff. */
export const STABLE_RUN_MS = 60_000;

export interface ExitInfo {
  code: number | null;
  /** Quanto tempo o processo ficou no ar antes de sair. */
  ranMs: number;
}

/** Decide quando reiniciar um filho que saiu. Devolve a espera em ms (0 = agora). */
export class RestartPolicy {
  private failures = 0;

  nextDelay(exit: ExitInfo): number {
    if (exit.code === RELOAD_EXIT_CODE) {
      this.failures = 0;
      return 0;
    }
    if (exit.ranMs >= STABLE_RUN_MS) this.failures = 0;
    const index = Math.min(this.failures, RESTART_BACKOFF_MS.length - 1);
    this.failures += 1;
    return RESTART_BACKOFF_MS[index] ?? 30000;
  }
}
