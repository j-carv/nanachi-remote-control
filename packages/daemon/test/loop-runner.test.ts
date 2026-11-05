import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  LOOP_DYNAMIC_DEFAULT_MS,
  LOOP_INTERVAL_MAX_MS,
  LOOP_INTERVAL_MIN_MS,
  type Loop,
  type LoopRequest,
  type SessionStatus,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  clampLoopDelay,
  LOOP_BUSY_RECHECK_MS,
  LOOP_RESTART_DELAY_MS,
  LoopBusyError,
  LoopError,
  LoopRunner,
  parseLoopMarker,
  type LoopHost,
  type LoopTurn,
} from '../src/loop-runner.js';
import { findLoop, insertSession, type StoredLoop } from '../src/repository.js';

const SESSION = 's-1';
const T0 = 1_700_000_000_000;
const MIN = 60_000;

/** Host de teste: status por sessão, envio gravado, sem agente. `sendFails` troca o resultado do envio. */
class FakeHost implements LoopHost {
  readonly statuses = new Map<string, SessionStatus>();
  readonly sent: Array<{ sessionId: string; text: string; turn: LoopTurn }> = [];
  readonly changes: Array<{ sessionId: string; loop: Loop | null }> = [];
  sendFailure: Error | undefined;
  readonly warnings: string[] = [];
  readonly failures: Array<{ sessionId: string; message: string }> = [];

  constructor(status: SessionStatus = 'idle') {
    this.statuses.set(SESSION, status);
  }

  statusOf(sessionId: string): SessionStatus | undefined {
    return this.statuses.get(sessionId);
  }

  send(sessionId: string, text: string, turn: LoopTurn): Promise<void> {
    this.sent.push({ sessionId, text, turn });
    return this.sendFailure === undefined ? Promise.resolve() : Promise.reject(this.sendFailure);
  }

  changed(sessionId: string, loop: Loop | null): void {
    this.changes.push({ sessionId, loop });
  }

  failed(sessionId: string, message: string): void {
    this.failures.push({ sessionId, message });
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

let dir: string;
let db: Database.Database;
let host: FakeHost;
let runner: LoopRunner;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  dir = await mkdtemp(join(tmpdir(), 'nanachi-loop-runner-'));
  db = openDatabase(join(dir, 'data.db'));
  insertSession(db, {
    id: SESSION,
    workspaceId: 'w-1',
    agent: 'fake',
    title: 'teste',
    status: 'idle',
    createdAt: T0,
  });
  host = new FakeHost();
  runner = new LoopRunner(db, host);
});

afterEach(async () => {
  runner.close();
  db.close();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

/** Deixa o tempo andar e drena as microtarefas (o disparo do loop é assíncrono). */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function intervalRequest(overrides: Partial<LoopRequest> = {}): LoopRequest {
  return { prompt: 'verifica o deploy', mode: 'interval', intervalMs: MIN, runNow: true, ...overrides };
}

function dynamicRequest(overrides: Partial<LoopRequest> = {}): LoopRequest {
  return { prompt: 'continua a migração', mode: 'dynamic', runNow: true, ...overrides };
}

/** Fecha o turno da iteração em curso com um texto do agente (marcadores incluídos) e um stopReason. */
function finishTurn(text = '', stopReason = 'end_turn'): void {
  if (text !== '') runner.observeText(SESSION, text);
  runner.turnEnded(SESSION, { stopReason });
}

/** Código do LoopError lançado por `action`, ou undefined se não lançou. */
function codeOf(action: () => void): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof LoopError ? error.code : 'outro erro';
  }
  return undefined;
}

function stored(): StoredLoop {
  const loop = findLoop(db, SESSION);
  if (loop === undefined) throw new Error('loop não gravado');
  return loop;
}

describe('LoopRunner: intervalo mede do fim do turno', () => {
  it('a próxima iteração é intervalMs depois do turn_end, não do início', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(host.sent).toHaveLength(1);

    await advance(10_000);
    finishTurn();
    expect(stored().nextRunAt).toBe(T0 + 10_000 + MIN);

    await advance(MIN - 1);
    expect(host.sent).toHaveLength(1);
    await advance(1);
    expect(host.sent).toHaveLength(2);
    expect(host.sent[1]?.turn).toEqual({ iteration: 2, selfPaced: false });
  });

  it('não há rajada: um turno longo não gera iterações atrasadas', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    await advance(5 * MIN);
    finishTurn();
    await advance(MIN);
    expect(host.sent.map((item) => item.turn.iteration)).toEqual([1, 2]);
    // Sem turn_end depois da iteração 2, nada mais é agendado, por mais tempo que passe.
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(2);
  });

  it('runNow false: a primeira iteração roda intervalMs depois da criação', async () => {
    runner.create(SESSION, intervalRequest({ runNow: false, intervalMs: 2 * MIN }));
    expect(stored().nextRunAt).toBe(T0 + 2 * MIN);
    await advance(2 * MIN - 1);
    expect(host.sent).toHaveLength(0);
    await advance(1);
    expect(host.sent).toHaveLength(1);
  });

  it('o prompt enviado é o do loop, sem instrução extra no modo interval', async () => {
    runner.create(SESSION, intervalRequest({ prompt: '/babysit-prs' }));
    await advance(0);
    expect(host.sent[0]).toMatchObject({ text: '/babysit-prs', turn: { iteration: 1, selfPaced: false } });
  });
});

describe('LoopRunner: sem sobreposição e sem fila', () => {
  it('sessão ocupada: a iteração espera e roda quando a sessão fica idle', async () => {
    host.statuses.set(SESSION, 'running');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(host.sent).toHaveLength(0);

    host.statuses.set(SESSION, 'idle');
    runner.onStatus(SESSION, 'idle');
    await advance(0);
    expect(host.sent).toHaveLength(1);
  });

  it('vários disparos enquanto ocupada não enfileiram: uma iteração só', async () => {
    host.statuses.set(SESSION, 'awaiting_permission');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    await advance(3 * MIN);
    expect(host.sent).toHaveLength(0);

    host.statuses.set(SESSION, 'idle');
    runner.onStatus(SESSION, 'idle');
    await advance(0);
    expect(host.sent).toHaveLength(1);
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(1);
  });

  it('starting conta como ocupada; error também libera a espera', async () => {
    host.statuses.set(SESSION, 'starting');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(host.sent).toHaveLength(0);

    host.statuses.set(SESSION, 'error');
    runner.onStatus(SESSION, 'error');
    await advance(0);
    expect(host.sent).toHaveLength(1);
  });

  it('nunca manda duas iterações sem o turno anterior terminar', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    await advance(5 * MIN);
    expect(host.sent).toHaveLength(1);
  });

  it('SessionManager que recusa com session_busy: a iteração espera de novo, sem pausar', async () => {
    host.sendFailure = new LoopBusyError('sessão não está ociosa (status: running)');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(stored().state).toBe('active');
    expect(stored().iterations).toBe(0);

    host.sendFailure = undefined;
    runner.onStatus(SESSION, 'idle');
    await advance(0);
    expect(host.sent).toHaveLength(2);
    expect(stored().iterations).toBe(1);
  });

  it('a espera não depende só do aviso de status: a checagem periódica acorda a iteração', async () => {
    host.statuses.set(SESSION, 'running');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(host.sent).toHaveLength(0);

    // The session goes idle without a status notice (no onStatus call): the loop must still run.
    host.statuses.set(SESSION, 'idle');
    await advance(LOOP_BUSY_RECHECK_MS);
    expect(host.sent).toHaveLength(1);
    expect(stored().iterations).toBe(1);
  });

  it('enquanto a sessão segue ocupada, a checagem não publica a cada tentativa', async () => {
    host.statuses.set(SESSION, 'running');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    const published = host.changes.length;

    await advance(10 * LOOP_BUSY_RECHECK_MS);
    expect(host.sent).toHaveLength(0);
    expect(host.changes.length).toBe(published);
  });

  it('pause() na fila cancela a checagem: nada roda depois', async () => {
    host.statuses.set(SESSION, 'running');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    runner.pause(SESSION);

    host.statuses.set(SESSION, 'idle');
    await advance(5 * LOOP_BUSY_RECHECK_MS);
    expect(host.sent).toHaveLength(0);
    expect(stored().state).toBe('paused');
  });
});

describe('LoopRunner: modo dynamic (marcadores do agente)', () => {
  it('lê o tempo do marcador da última resposta do turno', async () => {
    runner.create(SESSION, dynamicRequest());
    await advance(0);
    finishTurn('Feito o primeiro passo. [[nanachi-loop-next: 90s]]');
    expect(stored().nextRunAt).toBe(T0 + 90_000);
    await advance(90_000);
    expect(host.sent).toHaveLength(2);
    expect(host.sent[1]?.turn).toEqual({ iteration: 2, selfPaced: true });
  });

  it('sem marcador usa 10 min', async () => {
    runner.create(SESSION, dynamicRequest());
    await advance(0);
    finishTurn('resposta sem marcador');
    expect(stored().nextRunAt).toBe(T0 + LOOP_DYNAMIC_DEFAULT_MS);
  });

  it('dynamic com prompt de comando não recebe instrução e usa 10 min', async () => {
    runner.create(SESSION, dynamicRequest({ prompt: '/review' }));
    await advance(0);
    expect(host.sent[0]?.turn).toEqual({ iteration: 1, selfPaced: false });
    finishTurn('[[nanachi-loop-next: 2m]]');
    expect(stored().nextRunAt).toBe(T0 + LOOP_DYNAMIC_DEFAULT_MS);
  });

  it('vale o último marcador bem formado do turno', async () => {
    runner.create(SESSION, dynamicRequest());
    await advance(0);
    finishTurn('a [[nanachi-loop-next: 5m]] b [[nanachi-loop-next: 1h]] c');
    expect(stored().nextRunAt).toBe(T0 + 3_600_000);
  });

  it('marcador malformado (ex.: o placeholder da instrução ecoado) é ignorado', async () => {
    runner.create(SESSION, dynamicRequest());
    await advance(0);
    finishTurn('ecoei [[nanachi-loop-next: <duração>]] e nada mais');
    expect(stored().nextRunAt).toBe(T0 + LOOP_DYNAMIC_DEFAULT_MS);
  });

  it('o texto do turno é só o do agente nesta iteração', async () => {
    runner.create(SESSION, dynamicRequest());
    await advance(0);
    runner.observeText(SESSION, 'primeira ');
    finishTurn('[[nanachi-loop-next: 3m]]');
    await advance(3 * MIN);
    runner.observeText(SESSION, 'segunda sem marcador');
    finishTurn();
    expect(stored().nextRunAt).toBe(T0 + 3 * MIN + LOOP_DYNAMIC_DEFAULT_MS);
  });
});

describe('LoopRunner: parada', () => {
  it('marcador de parada encerra o loop e não agenda mais nada', async () => {
    runner.create(SESSION, dynamicRequest());
    await advance(0);
    finishTurn('tudo pronto [[nanachi-loop-stop]]');
    expect(stored()).toMatchObject({ state: 'stopped', nextRunAt: null });
    await advance(24 * 60 * MIN);
    expect(host.sent).toHaveLength(1);
  });

  it('parada vence quando é o último marcador', async () => {
    runner.create(SESSION, dynamicRequest());
    await advance(0);
    finishTurn('[[nanachi-loop-stop]] depois [[nanachi-loop-next: 1m]]');
    expect(stored().state).toBe('active');
    expect(stored().nextRunAt).toBe(T0 + MIN);
  });

  it('maxIterations: após a última iteração o loop vira stopped', async () => {
    runner.create(SESSION, intervalRequest({ maxIterations: 2 }));
    await advance(0);
    finishTurn();
    expect(stored()).toMatchObject({ state: 'active', iterations: 1 });
    await advance(MIN);
    finishTurn();
    expect(stored()).toMatchObject({ state: 'stopped', iterations: 2, nextRunAt: null });
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(2);
  });

  it('maxIterations 1 com runNow: uma iteração e pronto', async () => {
    runner.create(SESSION, intervalRequest({ maxIterations: 1 }));
    await advance(0);
    finishTurn();
    expect(stored().state).toBe('stopped');
  });

  it('stop() encerra o loop de uma sessão parada pelo usuário', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    finishTurn();
    runner.stop(SESSION);
    expect(stored()).toMatchObject({ state: 'stopped', nextRunAt: null });
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(1);
  });

  it('stop() durante um turno: o turno que termina depois não reagenda', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    runner.stop(SESSION);
    finishTurn();
    expect(stored().state).toBe('stopped');
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(1);
  });
});

describe('LoopRunner: falhas e pausas', () => {
  it('falha de turno avisa o host (Web Push "Loop pausado") com a mensagem', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    runner.turnEnded(SESSION, { error: 'agente caiu' });
    expect(host.failures).toEqual([{ sessionId: SESSION, message: 'agente caiu' }]);
  });

  it('stopReason error também avisa o host', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    finishTurn('', 'error');
    expect(host.failures).toEqual([{ sessionId: SESSION, message: 'turno terminou com erro' }]);
  });

  it('falha ao iniciar a iteração (envio rejeitado) avisa o host', async () => {
    host.sendFailure = new Error('resume falhou');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(stored()).toMatchObject({ state: 'paused', lastError: 'resume falhou' });
    expect(host.failures).toEqual([{ sessionId: SESSION, message: 'resume falhou' }]);
  });

  it('Parar do usuário (cancelled) e sessão ocupada não avisam o host', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    finishTurn('', 'cancelled');
    expect(host.failures).toEqual([]);

    host.statuses.set(SESSION, 'running');
    runner.resume(SESSION);
    host.sendFailure = new LoopBusyError('sessão não está ociosa (status: running)');
    host.statuses.set(SESSION, 'idle');
    runner.onStatus(SESSION, 'idle');
    await advance(0);
    expect(host.failures).toEqual([]);
  });

  it('turno com erro pausa com lastError e não reagenda', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    runner.turnEnded(SESSION, { error: 'agente caiu' });
    expect(stored()).toMatchObject({ state: 'paused', nextRunAt: null, lastError: 'agente caiu' });
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(1);
  });

  it('stopReason error pausa com a mensagem do turno', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    finishTurn('', 'error');
    expect(stored()).toMatchObject({ state: 'paused', lastError: 'turno terminou com erro' });
  });

  it('stopReason cancelled (Parar do usuário) pausa sem lastError', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    finishTurn('', 'cancelled');
    expect(stored()).toMatchObject({ state: 'paused', lastError: null });
  });

  it('outros stopReason (max_tokens, refusal) continuam o loop', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    finishTurn('', 'max_tokens');
    expect(stored().state).toBe('active');
    expect(stored().nextRunAt).toBe(T0 + MIN);
  });

  it('falha ao iniciar (resume falhou): pausa com a mensagem e desfaz a contagem', async () => {
    host.sendFailure = new Error('retomada falhou');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(stored()).toMatchObject({ state: 'paused', iterations: 0, lastError: 'retomada falhou' });
  });

  it('resume() tira o lastError e agenda para já', async () => {
    host.sendFailure = new Error('falhou');
    runner.create(SESSION, intervalRequest());
    await advance(0);
    host.sendFailure = undefined;
    runner.resume(SESSION);
    expect(stored()).toMatchObject({ state: 'active', lastError: null });
    await advance(0);
    expect(host.sent).toHaveLength(2);
  });

  it('pause() no meio de um turno: o turno termina e nada é agendado', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    runner.pause(SESSION);
    finishTurn();
    expect(stored()).toMatchObject({ state: 'paused', nextRunAt: null });
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(1);
  });

  it('pause() cancela o disparo agendado', async () => {
    runner.create(SESSION, intervalRequest({ runNow: false }));
    runner.pause(SESSION);
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(0);
    expect(stored().state).toBe('paused');
  });

  it('pause() de loop já pausado não muda nada', async () => {
    runner.create(SESSION, intervalRequest({ runNow: false }));
    runner.pause(SESSION);
    const changes = host.changes.length;
    runner.pause(SESSION);
    expect(stored().state).toBe('paused');
    expect(host.changes.length).toBe(changes);
  });

  it('run-now de loop pausado roda uma vez e continua pausado', async () => {
    runner.create(SESSION, intervalRequest({ runNow: false }));
    runner.pause(SESSION);
    runner.runNow(SESSION);
    await advance(0);
    expect(host.sent).toHaveLength(1);
    finishTurn();
    expect(stored()).toMatchObject({ state: 'paused', iterations: 1 });
  });

  it('run-now de loop pausado que falha guarda o erro em lastError', async () => {
    runner.create(SESSION, intervalRequest({ runNow: false }));
    runner.pause(SESSION);
    runner.runNow(SESSION);
    await advance(0);
    runner.turnEnded(SESSION, { error: 'agente caiu no run-now' });
    expect(stored()).toMatchObject({ state: 'paused', lastError: 'agente caiu no run-now' });
  });

  it('o texto de um turno longo fica limitado e o marcador do fim ainda é lido', async () => {
    runner.create(SESSION, dynamicRequest());
    await advance(0);
    // Mais que o teto de texto guardado por turno (1 MiB): o início some, o marcador do fim não.
    const chunk = 'x'.repeat(64 * 1024);
    for (let index = 0; index < 40; index += 1) runner.observeText(SESSION, chunk);
    finishTurn('[[nanachi-loop-next: 7m]]');
    expect(stored().nextRunAt).toBe(T0 + 7 * MIN);
  });
});

describe('LoopRunner: erros de operação', () => {
  it('pausar, retomar ou rodar sem loop: loop_not_found', () => {
    expect(codeOf(() => runner.pause(SESSION))).toBe('loop_not_found');
    expect(codeOf(() => runner.resume(SESSION))).toBe('loop_not_found');
    expect(codeOf(() => runner.runNow(SESSION))).toBe('loop_not_found');
  });

  it('loop parado não volta com resume nem run-now: loop_finished', () => {
    runner.create(SESSION, intervalRequest({ runNow: false }));
    runner.stop(SESSION);
    expect(codeOf(() => runner.resume(SESSION))).toBe('loop_finished');
    expect(codeOf(() => runner.runNow(SESSION))).toBe('loop_finished');
  });

  it('run-now com iteração em curso: loop_busy', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(codeOf(() => runner.runNow(SESSION))).toBe('loop_busy');
  });

  it('PUT com iteração em curso: loop_busy', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(codeOf(() => runner.create(SESSION, dynamicRequest()))).toBe('loop_busy');
  });

  it('PUT troca o loop existente e zera a contagem', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    finishTurn();
    runner.create(SESSION, dynamicRequest({ runNow: false }));
    expect(stored()).toMatchObject({ mode: 'dynamic', intervalMs: null, iterations: 0, state: 'active' });
  });

  it('remove() apaga o loop e nada mais dispara; turno em curso não reagenda', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    runner.remove(SESSION);
    expect(findLoop(db, SESSION)).toBeUndefined();
    finishTurn();
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(1);
  });

  it('drop() tira a memória da sessão sem apagar a linha (quem apaga é deleteSessionRows)', () => {
    runner.create(SESSION, intervalRequest({ runNow: false }));
    runner.drop(SESSION);
    expect(findLoop(db, SESSION)).toBeDefined();
  });
});

describe('LoopRunner: estado e avisos', () => {
  it('cada snapshot publicado ou lido tem revisão maior que o anterior', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    // The HTTP reply of an action is a snapshot taken now; the turn's end is published after it.
    const response = runner.get(SESSION);
    if (response === null) throw new Error('loop esperado');
    finishTurn();
    const published = host.changes.at(-1)?.loop;
    if (published === null || published === undefined) throw new Error('aviso esperado');
    expect(published.revision).toBeGreaterThan(response.revision);
    expect(runner.get(SESSION)?.revision).toBeGreaterThan(published.revision);
  });

  it('avisa cada mudança com o loop gravado (ou null ao apagar)', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    finishTurn();
    runner.remove(SESSION);
    const last = host.changes.at(-1);
    expect(last).toEqual({ sessionId: SESSION, loop: null });
    expect(host.changes.some((change) => change.loop?.iterations === 1)).toBe(true);
  });

  it('cada iteração que começa grava iterations, lastRunAt e nextRunAt null', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    expect(stored()).toMatchObject({ iterations: 1, lastRunAt: T0, nextRunAt: null });
  });

  it('restore() reagenda loops ativos: futuro mantém a hora; passado ou nulo roda em 5 s', async () => {
    const other = 's-2';
    insertSession(db, { id: other, workspaceId: 'w-1', agent: 'fake', title: 'b', status: 'idle', createdAt: T0 });
    host.statuses.set(other, 'idle');
    runner.create(SESSION, intervalRequest({ runNow: false, intervalMs: 5 * MIN }));
    runner.create(other, intervalRequest({ runNow: false, intervalMs: MIN }));
    // Reinício: `other` ficou com a hora no passado (ex.: daemon caiu antes do disparo); `SESSION` no futuro.
    db.prepare('UPDATE loops SET next_run_at = ? WHERE session_id = ?').run(T0 - 1000, other);
    runner.close();

    runner = new LoopRunner(db, host);
    runner.restore();
    await advance(LOOP_RESTART_DELAY_MS - 1);
    expect(host.sent).toHaveLength(0);
    await advance(1);
    expect(host.sent.map((item) => item.sessionId)).toEqual([other]);
    expect(stored().nextRunAt).toBe(T0 + 5 * MIN);
  });

  it('restore() com nextRunAt nulo (daemon caiu no meio de uma iteração) reagenda em 5 s', async () => {
    runner.create(SESSION, intervalRequest());
    await advance(0);
    runner.close();

    runner = new LoopRunner(db, host);
    runner.restore();
    await advance(LOOP_RESTART_DELAY_MS);
    expect(host.sent).toHaveLength(2);
    expect(stored().iterations).toBe(2);
  });

  it('restore() não reagenda loops parados ou pausados', () => {
    runner.create(SESSION, intervalRequest({ runNow: false }));
    runner.pause(SESSION);
    runner.close();
    runner = new LoopRunner(db, host);
    runner.restore();
    vi.advanceTimersByTime(MIN * 60);
    expect(host.sent).toHaveLength(0);
  });

  it('close() cancela os disparos; nada roda depois', async () => {
    runner.create(SESSION, intervalRequest({ runNow: false }));
    runner.close();
    await advance(10 * MIN);
    expect(host.sent).toHaveLength(0);
  });
});

describe('LoopRunner: validação de intervalo', () => {
  it('runNow false com o intervalo máximo (24 h) agenda na hora certa', () => {
    runner.create(SESSION, intervalRequest({ intervalMs: LOOP_INTERVAL_MAX_MS, runNow: false }));
    expect(stored().nextRunAt).toBe(T0 + LOOP_INTERVAL_MAX_MS);
  });
});

describe('parseLoopMarker', () => {
  it('sem marcador: undefined', () => {
    expect(parseLoopMarker('nada aqui')).toBeUndefined();
  });

  it('lê next com as unidades aceitas', () => {
    expect(parseLoopMarker('[[nanachi-loop-next: 90s]]')).toEqual({ kind: 'next', delayMs: 90_000 });
    expect(parseLoopMarker('[[nanachi-loop-next:10m]]')).toEqual({ kind: 'next', delayMs: 600_000 });
    expect(parseLoopMarker('[[nanachi-loop-next: 1h30m]]')).toEqual({ kind: 'next', delayMs: 5_400_000 });
  });

  it('limita next a 30 s e 24 h', () => {
    expect(parseLoopMarker('[[nanachi-loop-next: 5s]]')).toEqual({ kind: 'next', delayMs: LOOP_INTERVAL_MIN_MS });
    expect(parseLoopMarker('[[nanachi-loop-next: 0s]]')).toEqual({ kind: 'next', delayMs: LOOP_INTERVAL_MIN_MS });
    expect(parseLoopMarker('[[nanachi-loop-next: 72h]]')).toEqual({ kind: 'next', delayMs: LOOP_INTERVAL_MAX_MS });
  });

  it('stop', () => {
    expect(parseLoopMarker('fim\n[[nanachi-loop-stop]]')).toEqual({ kind: 'stop' });
  });

  it('o último bem formado vence; malformado não conta', () => {
    expect(parseLoopMarker('[[nanachi-loop-next: 1m]] [[nanachi-loop-stop]]')).toEqual({ kind: 'stop' });
    expect(parseLoopMarker('[[nanachi-loop-stop]] [[nanachi-loop-next: 2m]]')).toEqual({ kind: 'next', delayMs: 120_000 });
    expect(parseLoopMarker('[[nanachi-loop-next: 2m]] [[nanachi-loop-next: abc]]')).toEqual({ kind: 'next', delayMs: 120_000 });
    expect(parseLoopMarker('[[nanachi-loop-stopped]]')).toBeUndefined();
  });

  it('clampLoopDelay limita a faixa', () => {
    expect(clampLoopDelay(1)).toBe(LOOP_INTERVAL_MIN_MS);
    expect(clampLoopDelay(MIN)).toBe(MIN);
    expect(clampLoopDelay(LOOP_INTERVAL_MAX_MS * 2)).toBe(LOOP_INTERVAL_MAX_MS);
  });
});

