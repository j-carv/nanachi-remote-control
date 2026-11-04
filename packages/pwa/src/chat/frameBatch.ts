export interface FrameBatcherOptions<T> {
  /** Agenda `callback` para o próximo quadro; devolve um identificador para cancelar. */
  schedule(callback: () => void): number;
  cancel(handle: number): void;
  /** Recebe os itens do quadro, na ordem em que chegaram. Só é chamado com lote não vazio. */
  flush(batch: readonly T[]): void;
}

export interface FrameBatcher<T> {
  push(item: T): void;
  /** Entrega o que está pendente agora e cancela o quadro agendado. */
  flushNow(): void;
  /** Cancela o quadro e descarta o pendente (desmontagem). */
  dispose(): void;
}

/**
 * Junta os itens que chegam no mesmo quadro de animação num único flush. Evita um setState por evento
 * (streaming manda um chunk por evento) e mantém a ordem.
 */
export function createFrameBatcher<T>(options: FrameBatcherOptions<T>): FrameBatcher<T> {
  let pending: T[] = [];
  let handle: number | null = null;

  function cancelScheduled() {
    if (handle !== null) {
      options.cancel(handle);
      handle = null;
    }
  }

  function take(): readonly T[] {
    const batch = pending;
    pending = [];
    return batch;
  }

  return {
    push(item) {
      pending.push(item);
      if (handle !== null) return;
      handle = options.schedule(() => {
        handle = null;
        const batch = take();
        if (batch.length > 0) options.flush(batch);
      });
    },

    flushNow() {
      cancelScheduled();
      const batch = take();
      if (batch.length > 0) options.flush(batch);
    },

    dispose() {
      cancelScheduled();
      pending = [];
    },
  };
}
