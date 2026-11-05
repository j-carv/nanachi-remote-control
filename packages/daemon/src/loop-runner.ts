import {
  LOOP_DYNAMIC_DEFAULT_MS,
  LOOP_INTERVAL_MAX_MS,
  LOOP_INTERVAL_MIN_MS,
  parseLoopDuration,
  type Loop,
  type LoopRequest,
  type SessionStatus,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { isSlashCommand } from './acp-mapping.js';
import { deleteLoop, findLoop, listActiveLoops, replaceLoop, updateLoop, type StoredLoop } from './repository.js';

/** Próxima execução de um loop que estava pronto quando o daemon subiu (depois do reload, dá tempo de retomar). */
export const LOOP_RESTART_DELAY_MS = 5_000;

/**
 * Intervalo da checagem enquanto uma iteração espera a sessão ficar livre. O aviso de status (`onStatus`) é o caminho
 * rápido; esta checagem cobre transição de status que não passa por ele.
 */
export const LOOP_BUSY_RECHECK_MS = 2_000;

/**
 * Instrução do modo dynamic, mandada como bloco de texto depois do prompt do usuário. Em português, porque o
 * usuário escreve em português. Não entra no evento `user_message`, como o aviso do phone-send.
 */
export const LOOP_SELF_PACE_INSTRUCTION = [
  '[Nanachi Remote] Esta execução faz parte de um loop que se repete. No fim da sua resposta, em linha própria, escreva um destes marcadores:',
  '[[nanachi-loop-next: <duração>]] para o tempo até a próxima execução, por exemplo 90s, 10m ou 2h (mínimo 30s, máximo 24h).',
  '[[nanachi-loop-stop]] se a tarefa estiver concluída e o loop não precisa continuar.',
  'Sem marcador, a próxima execução acontece em 10 minutos.',
].join('\n');

/** Estados em que a sessão está ocupada: a iteração espera até ela voltar a `idle` (ou `error`). */
const BUSY_STATUSES: readonly SessionStatus[] = ['starting', 'running', 'awaiting_permission'];
/** Texto do agente guardado por iteração: o marcador vem no fim, então basta a cauda. */
const TURN_TEXT_MAX = 1_048_576;
/** Causa de pausa quando o turno termina com `stopReason: "error"` (não existe em ACP v1; tratado por segurança). */
const ERROR_STOP_REASON_MESSAGE = 'turno terminou com erro';

export type LoopErrorCode = 'loop_not_found' | 'loop_finished' | 'loop_busy';

/** Erro de operação sobre o loop; o SessionManager traduz para SessionError (HTTP). */
export class LoopError extends Error {
  readonly code: LoopErrorCode;

  constructor(code: LoopErrorCode, message: string) {
    super(message);
    this.name = 'LoopError';
    this.code = code;
  }
}

/**
 * Lançado pelo host quando a sessão ficou ocupada antes do envio (outro prompt entrou primeiro). A iteração não
 * conta e espera a sessão ficar ociosa; não pausa o loop.
 */
export class LoopBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopBusyError';
  }
}

/** Identificação de uma iteração, levada até o envio do prompt (e gravada no `user_message`). */
export interface LoopTurn {
  iteration: number;
  /** Modo dynamic com prompt que não é comando: o agente recebe a instrução de marcadores. */
  selfPaced: boolean;
}

/** Como um turno do loop terminou: stopReason do ACP, ou erro (rejeição do prompt). */
export type TurnOutcome = { stopReason: string } | { error: string };

/** O que o loop precisa do SessionManager. Implementado por ele; nos testes, por um fake. */
export interface LoopHost {
  /** Status da sessão agora. Undefined = a sessão não existe mais. */
  statusOf(sessionId: string): SessionStatus | undefined;
  /**
   * Manda o prompt da iteração (retoma a sessão se estiver parada). Resolve quando o turno começou. Rejeita com
   * LoopBusyError se a sessão ficou ocupada antes; com outro erro, a iteração falha e o loop pausa.
   */
  send(sessionId: string, text: string, turn: LoopTurn): Promise<void>;
  /** O loop mudou (ou foi apagado: null). Quem assina a sessão recebe a mensagem `loop`. */
  changed(sessionId: string, loop: Loop | null): void;
  /** Uma iteração falhou e o loop pausou com `message` (lastError): avisa o celular (Web Push). */
  failed(sessionId: string, message: string): void;
  warn(message: string): void;
}

export type LoopMarker = { kind: 'stop' } | { kind: 'next'; delayMs: number };

/** Limita um atraso ao intervalo do loop (30 s a 24 h). */
export function clampLoopDelay(ms: number): number {
  return Math.min(LOOP_INTERVAL_MAX_MS, Math.max(LOOP_INTERVAL_MIN_MS, ms));
}

/**
 * Último marcador bem formado da resposta do agente: `[[nanachi-loop-stop]]` ou `[[nanachi-loop-next: <duração>]]`
 * (a duração segue `parseLoopDuration`, limitada a 30 s–24 h). Marcador malformado é ignorado, inclusive o
 * placeholder `<duração>` da instrução se o agente o repetir. Sem marcador válido: undefined.
 */
export function parseLoopMarker(text: string): LoopMarker | undefined {
  let last: LoopMarker | undefined;
  for (const match of text.matchAll(/\[\[nanachi-loop-(stop|next:[^\]\n]*)\]\]/g)) {
    const body = match[1] ?? '';
    if (body === 'stop') {
      last = { kind: 'stop' };
      continue;
    }
    const delayMs = parseLoopDuration(body.slice('next:'.length).trim());
    if (delayMs !== undefined) last = { kind: 'next', delayMs: clampLoopDelay(delayMs) };
  }
  return last;
}

interface Flight {
  iteration: number;
  selfPaced: boolean;
  text: string;
}

/**
 * Loops de sessão (PLAN.md, "modo Loop"). Uma iteração por vez por sessão: o disparo espera a sessão ficar ociosa,
 * nunca enfileira mais de uma, e o próximo agendamento sai do fim do turno. Estado de execução (timers, turno em
 * curso, espera) fica em memória; o loop em si fica na tabela `loops`, e `restore()` reagenda ao subir.
 */
export class LoopRunner {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Iteração enviada e ainda sem `turn_end`. Enquanto existe, a sessão não recebe outra iteração do loop. */
  private readonly flights = new Map<string, Flight>();
  /** Iterações esperando a sessão ficar ociosa. Valor: se a espera veio de um disparo manual (run-now). */
  private readonly waiting = new Map<string, boolean>();
  /** Última revisão dada a cada loop (ordem dos snapshots, ver `snapshot`). */
  private readonly revisions = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly db: Database.Database,
    private readonly host: LoopHost,
    private readonly restartDelayMs: number = LOOP_RESTART_DELAY_MS,
  ) {}

  /** Na subida: reagenda os loops ativos. `nextRunAt` no passado ou nulo roda `restartDelayMs` depois. */
  restore(): void {
    const now = Date.now();
    for (const loop of listActiveLoops(this.db)) {
      const due = loop.nextRunAt === null || loop.nextRunAt < now ? now + this.restartDelayMs : loop.nextRunAt;
      this.schedule(loop.sessionId, due);
    }
  }

  /** Loop da sessão como snapshot, ou null. */
  get(sessionId: string): Loop | null {
    return this.snapshot(sessionId);
  }

  /**
   * Cria o loop ou troca o que houver (PUT). Estado `active`, contagem zerada. `runNow` (padrão) roda já; senão a
   * primeira iteração sai depois do intervalo (modo interval) ou do padrão de 10 min (dynamic).
   */
  create(sessionId: string, request: LoopRequest): Loop {
    if (this.flights.has(sessionId)) {
      throw new LoopError('loop_busy', 'uma iteração do loop está rodando: troque o loop depois dela');
    }
    const now = Date.now();
    const loop: StoredLoop = {
      sessionId,
      prompt: request.prompt,
      mode: request.mode,
      intervalMs: request.mode === 'interval' ? (request.intervalMs ?? null) : null,
      maxIterations: request.maxIterations ?? null,
      iterations: 0,
      state: 'active',
      nextRunAt: null,
      lastRunAt: null,
      lastError: null,
      createdAt: now,
    };
    this.clearTimer(sessionId);
    this.waiting.delete(sessionId);
    replaceLoop(this.db, loop);
    const firstDelay = loop.mode === 'interval' ? (loop.intervalMs ?? LOOP_DYNAMIC_DEFAULT_MS) : LOOP_DYNAMIC_DEFAULT_MS;
    this.schedule(sessionId, request.runNow === false ? now + firstDelay : now);
    this.publish(sessionId);
    return this.current(sessionId);
  }

  /** Pausa um loop ativo (cancela o disparo; um turno em curso termina e não reagenda). Já pausado: nada. */
  pause(sessionId: string): Loop {
    const loop = this.current(sessionId);
    if (loop.state === 'stopped') throw new LoopError('loop_finished', 'loop já terminou: crie outro');
    if (loop.state === 'active') this.halt(sessionId, 'paused', loop.lastError);
    return this.current(sessionId);
  }

  /** Volta um loop pausado: a próxima iteração roda já (quando a sessão estiver ociosa) e `lastError` some. */
  resume(sessionId: string): Loop {
    const loop = this.current(sessionId);
    if (loop.state === 'stopped') throw new LoopError('loop_finished', 'loop já terminou: crie outro');
    if (loop.state === 'paused') {
      this.schedule(sessionId, Date.now());
      updateLoop(this.db, sessionId, { lastError: null });
      this.publish(sessionId);
    }
    return this.current(sessionId);
  }

  /** Roda uma iteração agora, sem mudar o estado (um loop pausado roda uma vez e continua pausado). */
  runNow(sessionId: string): Loop {
    const loop = this.current(sessionId);
    if (loop.state === 'stopped') throw new LoopError('loop_finished', 'loop já terminou: crie outro');
    if (this.flights.has(sessionId)) throw new LoopError('loop_busy', 'uma iteração do loop está rodando');
    this.clearTimer(sessionId);
    this.runFire(sessionId, true);
    return this.current(sessionId);
  }

  /** Apaga o loop (DELETE). Um turno em curso termina sozinho; nada mais é agendado. */
  remove(sessionId: string): void {
    this.current(sessionId);
    this.forget(sessionId);
    deleteLoop(this.db, sessionId);
    this.revisions.delete(sessionId);
    this.host.changed(sessionId, null);
  }

  /** Encerra o loop da sessão que o usuário parou (ou que saiu do workspace). Sem loop, nada. */
  stop(sessionId: string): void {
    const loop = findLoop(this.db, sessionId);
    this.forget(sessionId);
    if (loop === undefined || loop.state === 'stopped') return;
    this.halt(sessionId, 'stopped', null);
  }

  /** Tira da memória a sessão que sai do app. A linha é apagada por quem remove a sessão (deleteSessionRows). */
  drop(sessionId: string): void {
    this.forget(sessionId);
    this.revisions.delete(sessionId);
  }

  /** Texto do agente numa iteração em curso: o marcador de tempo sai daí. */
  observeText(sessionId: string, text: string): void {
    const flight = this.flights.get(sessionId);
    if (flight === undefined) return;
    flight.text += text;
    // Corta só quando passa do dobro do teto: o corte é barato e o texto não é copiado a cada chunk.
    if (flight.text.length > TURN_TEXT_MAX * 2) flight.text = flight.text.slice(-TURN_TEXT_MAX);
  }

  /**
   * Um turno terminou (ou falhou). Só age se o turno era de uma iteração do loop. Falha e parada do usuário pausam
   * mesmo quando a iteração veio de um run-now de loop pausado (o erro precisa aparecer em `lastError`).
   */
  turnEnded(sessionId: string, outcome: TurnOutcome): void {
    const flight = this.flights.get(sessionId);
    if (flight === undefined) return;
    this.flights.delete(sessionId);
    const loop = findLoop(this.db, sessionId);
    if (loop === undefined || loop.state === 'stopped') return;

    if ('error' in outcome) {
      this.pauseWithError(sessionId, outcome.error);
      return;
    }
    if (outcome.stopReason === 'cancelled') {
      this.halt(sessionId, 'paused', null);
      return;
    }
    if (outcome.stopReason === 'error') {
      this.pauseWithError(sessionId, ERROR_STOP_REASON_MESSAGE);
      return;
    }
    // Pausado de propósito (run-now de loop pausado, ou pause durante o turno): nada é agendado.
    if (loop.state !== 'active') return;

    const marker = flight.selfPaced ? parseLoopMarker(flight.text) : undefined;
    if (marker?.kind === 'stop') {
      this.halt(sessionId, 'stopped', null);
      return;
    }
    if (loop.maxIterations !== null && loop.iterations >= loop.maxIterations) {
      this.halt(sessionId, 'stopped', null);
      return;
    }
    const delay =
      loop.mode === 'interval' ? (loop.intervalMs ?? LOOP_DYNAMIC_DEFAULT_MS) : (marker?.delayMs ?? LOOP_DYNAMIC_DEFAULT_MS);
    this.schedule(sessionId, Date.now() + delay);
    this.publish(sessionId);
  }

  /** A sessão mudou de status: se uma iteração esperava por isso, roda agora (fora da pilha de quem mudou). */
  onStatus(sessionId: string, status: SessionStatus): void {
    const manual = this.waiting.get(sessionId);
    if (manual === undefined) return;
    if (status !== 'idle' && status !== 'error') return;
    queueMicrotask(() => this.runFire(sessionId, manual));
  }

  /** Para todos os disparos. Depois disto nada roda (o shutdown fecha o banco logo em seguida). */
  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.flights.clear();
    this.waiting.clear();
  }

  /** Disparo de uma iteração, sem deixar erro escapar (o loop pausa ou espera; o log guarda o detalhe). */
  private runFire(sessionId: string, manual: boolean): void {
    this.fire(sessionId, manual).catch((error: unknown) => {
      this.host.warn(`loop da sessão ${sessionId} falhou: ${messageOf(error)}`);
    });
  }

  /**
   * Uma tentativa de iteração. Ordem: estado do loop, turno em curso, sessão ocupada (espera), contagem
   * (`maxIterations`), envio. Envio que falha: LoopBusyError espera; outro erro pausa com a mensagem.
   */
  private async fire(sessionId: string, manual: boolean): Promise<void> {
    if (this.closed) return;
    this.clearTimer(sessionId);
    const loop = findLoop(this.db, sessionId);
    if (loop === undefined || loop.state === 'stopped') {
      this.waiting.delete(sessionId);
      return;
    }
    if (loop.state === 'paused' && !manual) return;
    if (this.flights.has(sessionId)) return;

    const status = this.host.statusOf(sessionId);
    if (status === undefined) return;
    if (BUSY_STATUSES.includes(status)) {
      this.waitFor(sessionId, manual);
      return;
    }
    this.waiting.delete(sessionId);
    if (loop.maxIterations !== null && loop.iterations >= loop.maxIterations) {
      this.halt(sessionId, 'stopped', null);
      return;
    }

    const iteration = loop.iterations + 1;
    const turn: LoopTurn = {
      iteration,
      selfPaced: loop.mode === 'dynamic' && !isSlashCommand(loop.prompt),
    };
    // Gravado antes do envio: um daemon que cai no meio deixa a contagem certa (o reinício reagenda).
    updateLoop(this.db, sessionId, { iterations: iteration, lastRunAt: Date.now(), nextRunAt: null });
    this.flights.set(sessionId, { iteration, selfPaced: turn.selfPaced, text: '' });
    this.publish(sessionId);

    try {
      await this.host.send(sessionId, loop.prompt, turn);
    } catch (error) {
      this.flights.delete(sessionId);
      // A iteração não começou: desfaz a contagem.
      updateLoop(this.db, sessionId, { iterations: loop.iterations, lastRunAt: loop.lastRunAt });
      if (error instanceof LoopBusyError) {
        this.waitFor(sessionId, manual);
        return;
      }
      this.pauseWithError(sessionId, messageOf(error));
    }
  }

  /**
   * A iteração espera a sessão ficar livre: a fila aparece já (nextRunAt = agora) e uma checagem periódica tenta de
   * novo. Publica só quando a espera começa; as tentativas seguintes são silenciosas.
   */
  private waitFor(sessionId: string, manual: boolean): void {
    const alreadyWaiting = this.waiting.has(sessionId);
    this.waiting.set(sessionId, manual);
    this.clearTimer(sessionId);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.runFire(sessionId, manual);
    }, LOOP_BUSY_RECHECK_MS);
    this.timers.set(sessionId, timer);
    if (alreadyWaiting) return;
    updateLoop(this.db, sessionId, { nextRunAt: Date.now() });
    this.publish(sessionId);
  }

  /** Agenda o próximo disparo e marca o loop como `active` com essa hora. Não publica. */
  private schedule(sessionId: string, at: number): void {
    this.clearTimer(sessionId);
    updateLoop(this.db, sessionId, { state: 'active', nextRunAt: at });
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.runFire(sessionId, false);
    }, Math.max(0, at - Date.now()));
    this.timers.set(sessionId, timer);
  }

  /** Pausa por falha: guarda `lastError`, publica e avisa o celular. */
  private pauseWithError(sessionId: string, message: string): void {
    this.halt(sessionId, 'paused', message);
    this.host.failed(sessionId, message);
  }

  /** Para o loop em `state` (paused ou stopped), sem próximo disparo. Publica. */
  private halt(sessionId: string, state: 'paused' | 'stopped', lastError: string | null): void {
    this.clearTimer(sessionId);
    this.waiting.delete(sessionId);
    updateLoop(this.db, sessionId, { state, nextRunAt: null, lastError });
    this.publish(sessionId);
  }

  /** Esquece a execução em memória da sessão (timers, turno, espera). Não toca no banco. */
  private forget(sessionId: string): void {
    this.clearTimer(sessionId);
    this.waiting.delete(sessionId);
    this.flights.delete(sessionId);
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  /** Avisa quem assina a sessão com o estado atual do loop. */
  private publish(sessionId: string): void {
    this.host.changed(sessionId, this.snapshot(sessionId));
  }

  private current(sessionId: string): Loop {
    const loop = this.snapshot(sessionId);
    if (loop === null) throw new LoopError('loop_not_found', 'sessão sem loop');
    return loop;
  }

  /**
   * Loop com a revisão do momento da leitura. Revisão = max(relógio, anterior + 1): cresce em cada snapshot do
   * processo, e um processo novo (reload) começa acima do relógio, então também sobe em relação ao anterior.
   */
  private snapshot(sessionId: string): Loop | null {
    const stored = findLoop(this.db, sessionId);
    if (stored === undefined) return null;
    const revision = Math.max(Date.now(), (this.revisions.get(sessionId) ?? 0) + 1);
    this.revisions.set(sessionId, revision);
    return { ...stored, revision };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
