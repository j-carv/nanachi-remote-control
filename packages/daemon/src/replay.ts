import type { SessionEvent } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { listEvents } from './repository.js';

/** Eventos lidos do banco por lote no replay do subscribe. */
export const REPLAY_BATCH_SIZE = 200;

export interface ReplayOptions {
  /** Falso quando a inscrição foi cancelada (socket fechou, unsubscribe ou novo subscribe): para de entregar. */
  isActive(): boolean;
  batchSize?: number;
  /** Cede o event loop entre lotes. Padrão: setImmediate. */
  yieldToLoop?: () => Promise<void>;
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Entrega, em ordem, os eventos da sessão com seq > afterSeq. Lê o banco em lotes e cede o event loop
 * depois de cada lote, para que um replay grande não trave o daemon. Devolve o último seq entregue
 * (ou afterSeq, se não houve nenhum).
 */
export async function replayEvents(
  db: Database.Database,
  sessionId: string,
  afterSeq: number,
  deliver: (event: SessionEvent) => void,
  options: ReplayOptions,
): Promise<number> {
  const batchSize = options.batchSize ?? REPLAY_BATCH_SIZE;
  const yieldToLoop = options.yieldToLoop ?? yieldToEventLoop;
  let last = afterSeq;
  for (;;) {
    const batch = listEvents(db, sessionId, last, batchSize);
    if (batch.length === 0) return last;
    for (const event of batch) {
      if (!options.isActive()) return last;
      deliver(event);
      last = event.seq;
    }
    await yieldToLoop();
  }
}
