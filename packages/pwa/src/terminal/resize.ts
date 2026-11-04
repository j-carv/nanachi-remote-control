/** Atraso entre o último sinal de viewport e o fit + envio do tamanho. */
export const RESIZE_DEBOUNCE_MS = 150;

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export function sameSize(a: TerminalSize | null, b: TerminalSize): boolean {
  return a !== null && a.cols === b.cols && a.rows === b.rows;
}

export interface ResizeSchedulerOptions {
  delayMs: number;
  /** Faz o fit e devolve o tamanho resultante. */
  measure(): TerminalSize;
  /** Envia ao daemon. `false` = não enviou (offline); o próximo pedido tenta de novo. */
  send(size: TerminalSize): boolean;
  /** Falso = não há processo para receber o tamanho (terminal encerrado): nada é enviado nem marcado. */
  canSend?(): boolean;
}

export interface ResizeScheduler {
  /** Agenda fit + envio. Pedidos seguidos dentro da janela viram um só. */
  request(): void;
  /** Esquece o último tamanho enviado (o próximo pedido envia mesmo se for igual). */
  forget(): void;
  dispose(): void;
}

/**
 * Debounce do resize do terminal. Só envia quando cols/rows mudaram em relação ao último
 * envio que deu certo.
 */
export function createResizeScheduler(options: ResizeSchedulerOptions): ResizeScheduler {
  let sent: TerminalSize | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function run(): void {
    timer = null;
    const size = options.measure();
    if (options.canSend?.() === false) return;
    if (sameSize(sent, size)) return;
    if (options.send(size)) sent = size;
  }

  return {
    request() {
      clear();
      timer = setTimeout(run, options.delayMs);
    },
    forget() {
      sent = null;
    },
    dispose() {
      clear();
    },
  };
}
