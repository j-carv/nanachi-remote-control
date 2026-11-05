import type { SessionEvent } from '@nanachi/shared';

export interface TerminalExit {
  readonly exitCode: number | null;
  /** `reload`: the daemon closed the shell to reload. null when the process exited by itself. */
  readonly reason: 'reload' | null;
}

/**
 * Estado da saída de uma sessão PTY. O xterm guarda a tela; aqui só fica o que evita
 * escrever duas vezes (seq) e se o processo já terminou.
 */
export interface TerminalState {
  /** Maior seq já aplicado. Eventos com seq igual ou menor são ignorados. */
  readonly lastSeq: number;
  readonly exit: TerminalExit | null;
}

export interface TerminalIngest {
  readonly state: TerminalState;
  /** Dados a escrever no xterm, na ordem de seq. */
  readonly writes: readonly string[];
}

export function createTerminalState(): TerminalState {
  return { lastSeq: 0, exit: null };
}

/**
 * Aplica eventos em ordem de seq, idempotente: histórico + ao vivo, ou reconexão com replay,
 * não repetem saída. Eventos que não são de terminal só avançam o lastSeq.
 */
export function ingestTerminal(state: TerminalState, events: readonly SessionEvent[]): TerminalIngest {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const writes: string[] = [];
  let next = state;

  for (const event of ordered) {
    if (event.seq <= next.lastSeq) continue;
    if (event.kind === 'terminal_output') writes.push(event.data);
    next = {
      lastSeq: event.seq,
      exit:
        event.kind === 'terminal_exit' ? { exitCode: event.exitCode, reason: event.reason ?? null } : next.exit,
    };
  }

  return { state: next, writes };
}
