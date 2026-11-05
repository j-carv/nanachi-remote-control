import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LoopResponseSchema,
  WorkspaceSchema,
  type AgentConfig,
  type Loop,
  type LoopRequest,
  type ServerMessage,
  type SessionEvent,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  fakeAgent,
  listen,
  pairToken,
  promptsReceived,
  WsTestClient,
} from './agent-support.js';
import { openDatabase } from '../src/db.js';
import { findLoop, listEvents, stopInterruptedSessions, type StoredLoop } from '../src/repository.js';
import type { NotifyDetails, NotifyKind } from '../src/notify.js';
import { setupDaemonTests, startDaemon, stopDaemon, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Modo Loop pela API e pelo WS, contra o agente falso (PLAN.md, "modo Loop"). Tempo real: os disparos saem
 * na hora (runNow) ou em poucos segundos (reinício). A lógica de tempo fica em loop-runner.test.ts.
 */

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-loop-routes-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes dos daemons: o afterEach roda em pilha, então este roda por último.
const env = setupDaemonTests();

interface Notice {
  sessionId: string;
  kind: NotifyKind;
  details: NotifyDetails;
}

function agents(): Record<string, AgentConfig> {
  return {
    fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }),
    // PTY que só dorme: serve para provar que loop não vale para terminal.
    term: { label: 'Terminal', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], env: {}, kind: 'pty' },
  };
}

function config(): Record<string, unknown> {
  return { allowedRoots: [base], agents: agents(), phoneSendHint: false };
}

async function start(notices: Notice[] = []): Promise<TestDaemon> {
  return env.start({
    config: config(),
    onNotify: (sessionId, kind, details) => notices.push({ sessionId, kind, details }),
  });
}

async function workspaceId(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

async function api(
  daemon: TestDaemon,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await daemon.app.inject({
    method,
    url,
    headers: await authHeader(daemon),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.body === '' ? undefined : res.json<unknown>() };
}

/** Loop pela API (200 esperado). */
async function putLoop(daemon: TestDaemon, sessionId: string, request: LoopRequest): Promise<Loop> {
  const res = await api(daemon, 'PUT', `/api/sessions/${sessionId}/loop`, request);
  if (res.status !== 200) throw new Error(`PUT loop → ${res.status}: ${JSON.stringify(res.body)}`);
  const parsed = LoopResponseSchema.parse(res.body);
  if (parsed.loop === null) throw new Error('PUT devolveu loop null');
  return parsed.loop;
}

function loopOf(daemon: TestDaemon, sessionId: string): StoredLoop | undefined {
  return findLoop(daemon.db, sessionId);
}

function eventsOf(daemon: TestDaemon, sessionId: string): SessionEvent[] {
  return listEvents(daemon.db, sessionId, 0, 10_000);
}

/** Iterações do loop: user_message com `loop: true`, em ordem. */
function iterationsOf(daemon: TestDaemon, sessionId: string): Array<{ text: string; iteration: number | undefined }> {
  return eventsOf(daemon, sessionId).flatMap((event) =>
    event.kind === 'user_message' && event.loop === true ? [{ text: event.text, iteration: event.loopIteration }] : [],
  );
}

/** Espera uma condição (poll no banco); falha com `label` se não acontecer a tempo. */
async function until(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`não aconteceu a tempo: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Espera o loop ficar no estado pedido (ex.: 'stopped' depois de um marcador). */
async function untilState(daemon: TestDaemon, sessionId: string, state: Loop['state']): Promise<StoredLoop> {
  await until(() => loopOf(daemon, sessionId)?.state === state, `loop ${state}`);
  const loop = loopOf(daemon, sessionId);
  if (loop === undefined) throw new Error('loop sumiu');
  return loop;
}

async function untilSessionIdle(daemon: TestDaemon, sessionId: string): Promise<void> {
  await until(() => {
    const status = daemon.db.prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?').get(sessionId)?.status;
    return status === 'idle';
  }, 'sessão idle');
}

describe('rotas do loop', () => {
  it('GET sem loop devolve null; sessão inexistente, 404', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });

    expect(await api(daemon, 'GET', `/api/sessions/${session.id}/loop`)).toEqual({ status: 200, body: { loop: null } });
    expect((await api(daemon, 'GET', '/api/sessions/nao-existe/loop')).status).toBe(404);
    expect((await api(daemon, 'PUT', '/api/sessions/nao-existe/loop', { prompt: 'x', mode: 'dynamic' })).status).toBe(404);
  });

  it('PUT com corpo inválido é 400 (intervalo fora da faixa, interval sem intervalo, dynamic com intervalo)', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    const url = `/api/sessions/${session.id}/loop`;

    expect((await api(daemon, 'PUT', url, { prompt: 'x', mode: 'interval', intervalMs: 1000 })).status).toBe(400);
    expect((await api(daemon, 'PUT', url, { prompt: 'x', mode: 'interval' })).status).toBe(400);
    expect((await api(daemon, 'PUT', url, { prompt: 'x', mode: 'dynamic', intervalMs: 60_000 })).status).toBe(400);
    expect((await api(daemon, 'PUT', url, { mode: 'dynamic' })).status).toBe(400);
    expect(loopOf(daemon, session.id)).toBeUndefined();
  });

  it('loop em sessão de terminal é 409 not_acp', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'term' });
    const res = await api(daemon, 'PUT', `/api/sessions/${session.id}/loop`, { prompt: 'x', mode: 'dynamic' });
    expect(res).toMatchObject({ status: 409, body: { error: 'not_acp' } });
    await api(daemon, 'DELETE', `/api/sessions/${session.id}`);
  });

  it('interval com runNow: a primeira iteração roda já; o próximo disparo sai do fim do turno', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });

    const created = await putLoop(daemon, session.id, { prompt: 'verifica o deploy', mode: 'interval', intervalMs: 60_000 });
    expect(created).toMatchObject({ state: 'active', mode: 'interval', intervalMs: 60_000, iterations: 0 });

    await until(() => iterationsOf(daemon, session.id).length === 1, 'iteração 1');
    await untilSessionIdle(daemon, session.id);
    const after = loopOf(daemon, session.id);
    expect(after).toMatchObject({ state: 'active', iterations: 1, lastError: null });
    expect(after?.nextRunAt).toBeGreaterThan(Date.now() + 50_000);
    expect(after?.nextRunAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(iterationsOf(daemon, session.id)).toEqual([{ text: 'verifica o deploy', iteration: 1 }]);
  }, 20_000);

  it('runNow false não roda agora: a primeira iteração sai depois do intervalo', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    const created = await putLoop(daemon, session.id, {
      prompt: 'depois',
      mode: 'interval',
      intervalMs: 3_600_000,
      runNow: false,
    });
    expect(created.nextRunAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(iterationsOf(daemon, session.id)).toEqual([]);
  });

  it('modo dynamic: o marcador LOOP-NEXT=2m agenda 2 min depois; o agente recebe a instrução, o evento não', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    await putLoop(daemon, session.id, { prompt: 'LOOP-NEXT=2m', mode: 'dynamic' });

    await until(() => loopOf(daemon, session.id)?.nextRunAt !== null && loopOf(daemon, session.id)?.iterations === 1, 'agendado');
    const next = loopOf(daemon, session.id)?.nextRunAt ?? 0;
    expect(next - Date.now()).toBeGreaterThan(115_000);
    expect(next - Date.now()).toBeLessThanOrEqual(120_000);

    expect(iterationsOf(daemon, session.id)).toEqual([{ text: 'LOOP-NEXT=2m', iteration: 1 }]);
    const sent = await promptsReceived(pidDir, session.id);
    expect(sent).toHaveLength(1);
    const blocks = sent[0] ?? [];
    expect(blocks[0]).toEqual({ type: 'text', text: 'LOOP-NEXT=2m' });
    expect(blocks.at(-1)).toMatchObject({ type: 'text' });
    expect(JSON.stringify(blocks.at(-1))).toContain('Esta execução faz parte de um loop');
  }, 20_000);

  it('LOOP-STOP encerra o loop: resume e run-now dão 409 loop_finished; DELETE apaga', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    await putLoop(daemon, session.id, { prompt: 'LOOP-STOP', mode: 'dynamic' });
    await untilState(daemon, session.id, 'stopped');

    expect(await api(daemon, 'POST', `/api/sessions/${session.id}/loop/resume`)).toMatchObject({
      status: 409,
      body: { error: 'loop_finished' },
    });
    expect(await api(daemon, 'POST', `/api/sessions/${session.id}/loop/run-now`)).toMatchObject({
      status: 409,
      body: { error: 'loop_finished' },
    });
    expect((await api(daemon, 'DELETE', `/api/sessions/${session.id}/loop`)).status).toBe(204);
    expect(loopOf(daemon, session.id)).toBeUndefined();
  }, 20_000);

  it('maxIterations: a última iteração deixa o loop stopped, sem mais disparos', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    await putLoop(daemon, session.id, { prompt: 'uma vez', mode: 'interval', intervalMs: 30_000, maxIterations: 1 });

    const loop = await untilState(daemon, session.id, 'stopped');
    expect(loop).toMatchObject({ iterations: 1, maxIterations: 1, nextRunAt: null });
    expect(iterationsOf(daemon, session.id)).toHaveLength(1);
  }, 20_000);

  it('erro do turno pausa o loop com lastError e manda aviso (push) de erro', async () => {
    const notices: Notice[] = [];
    const daemon = await start(notices);
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    await putLoop(daemon, session.id, { prompt: 'LOOP-FAIL', mode: 'interval', intervalMs: 60_000 });

    const loop = await untilState(daemon, session.id, 'paused');
    expect(loop).toMatchObject({ iterations: 1, nextRunAt: null });
    expect(loop.lastError).toContain('falha simulada do turno');
    expect(notices.filter((notice) => notice.kind === 'error' && notice.sessionId === session.id)).toHaveLength(1);
  }, 20_000);

  it('pausa, retoma e roda agora: resume zera lastError; run-now de loop pausado roda uma vez e fica pausado', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    const url = `/api/sessions/${session.id}/loop`;
    await putLoop(daemon, session.id, { prompt: 'checa', mode: 'interval', intervalMs: 3_600_000, runNow: false });

    expect(await api(daemon, 'POST', `${url}/pause`)).toMatchObject({ status: 200, body: { loop: { state: 'paused' } } });
    const resumed = await api(daemon, 'POST', `${url}/resume`);
    expect(resumed).toMatchObject({ status: 200, body: { loop: { state: 'active' } } });
    await until(() => iterationsOf(daemon, session.id).length === 1, 'iteração depois do resume');

    await untilSessionIdle(daemon, session.id);
    await api(daemon, 'POST', `${url}/pause`);
    expect(await api(daemon, 'POST', `${url}/run-now`)).toMatchObject({ status: 200 });
    await until(() => iterationsOf(daemon, session.id).length === 2, 'run-now');
    await untilSessionIdle(daemon, session.id);
    expect(loopOf(daemon, session.id)).toMatchObject({ state: 'paused', iterations: 2 });
  }, 20_000);

  it('pausar, retomar ou rodar sem loop: 404 loop_not_found', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    for (const action of ['pause', 'resume', 'run-now']) {
      expect(await api(daemon, 'POST', `/api/sessions/${session.id}/loop/${action}`)).toMatchObject({
        status: 404,
        body: { error: 'loop_not_found' },
      });
    }
    expect(await api(daemon, 'DELETE', `/api/sessions/${session.id}/loop`)).toMatchObject({ status: 404 });
  });

  it('run-now com iteração em curso é 409 loop_busy', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    await putLoop(daemon, session.id, { prompt: 'slow', mode: 'interval', intervalMs: 60_000 });
    await until(() => loopOf(daemon, session.id)?.iterations === 1, 'iteração em curso');

    expect(await api(daemon, 'POST', `/api/sessions/${session.id}/loop/run-now`)).toMatchObject({
      status: 409,
      body: { error: 'loop_busy' },
    });
    // Corta o turno lento pelo WS, como o usuário faria no botão Parar.
    const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
    client.send({ type: 'cancel', sessionId: session.id });
    await untilSessionIdle(daemon, session.id);
    await client.close();
  }, 20_000);
});

describe('loop com a sessão', () => {
  it('ocupada: o loop espera a sessão ficar ociosa e não sobrepõe o turno do usuário', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
    client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
    await client.sync();

    client.send({ type: 'prompt', sessionId: session.id, text: 'slow' });
    await client.waitFor((message) => message.type === 'session' && message.session.status === 'running');

    await putLoop(daemon, session.id, { prompt: 'depois do turno', mode: 'interval', intervalMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(iterationsOf(daemon, session.id)).toEqual([]);
    expect(loopOf(daemon, session.id)?.state).toBe('active');

    client.send({ type: 'cancel', sessionId: session.id });
    await until(() => iterationsOf(daemon, session.id).length === 1, 'iteração depois do turno do usuário');
    await untilSessionIdle(daemon, session.id);
    await client.close();
  }, 20_000);

  it('sessão parada pelo usuário: o loop para junto (stopped), e não retoma sozinho', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    await putLoop(daemon, session.id, { prompt: 'x', mode: 'interval', intervalMs: 60_000, runNow: false });

    await api(daemon, 'DELETE', `/api/sessions/${session.id}`);
    expect(loopOf(daemon, session.id)).toMatchObject({ state: 'stopped', nextRunAt: null });
  });

  it('workspace apagado: o loop também para nas sessões que já estavam paradas', async () => {
    const daemon = await start();
    const wsId = await workspaceId(daemon);
    const session = await createSession(daemon, { workspaceId: wsId, agent: 'fake' });
    await putLoop(daemon, session.id, { prompt: 'x', mode: 'interval', intervalMs: 60_000, runNow: false });
    // Sessão parada pelo reinício do daemon: o loop continua ativo até o workspace sair.
    daemon.db.prepare("UPDATE sessions SET status = 'stopped' WHERE id = ?").run(session.id);

    expect((await api(daemon, 'DELETE', `/api/workspaces/${wsId}`)).status).toBe(204);
    expect(loopOf(daemon, session.id)).toMatchObject({ state: 'stopped', nextRunAt: null });
  });

  it('sessão removida do app (forget): o loop vai junto e a rota da sessão dá 404', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    await putLoop(daemon, session.id, { prompt: 'x', mode: 'interval', intervalMs: 60_000, runNow: false });

    expect((await api(daemon, 'DELETE', `/api/sessions/${session.id}?forget=1`)).status).toBe(204);
    expect(loopOf(daemon, session.id)).toBeUndefined();
    expect((await api(daemon, 'GET', `/api/sessions/${session.id}/loop`)).status).toBe(404);
  });

  it('WS: subscribe manda o loop (null incluso); cada mudança vai para quem assina', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
    client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
    const first = await client.waitFor(isLoopMessage(session.id));
    expect(first).toEqual({ type: 'loop', sessionId: session.id, loop: null });

    await putLoop(daemon, session.id, { prompt: 'checa', mode: 'interval', intervalMs: 3_600_000, runNow: false });
    const created = await client.waitFor(isLoopMessage(session.id, 'active'));
    expect(created).toMatchObject({ type: 'loop', loop: { state: 'active', prompt: 'checa' } });

    await api(daemon, 'POST', `/api/sessions/${session.id}/loop/pause`);
    await client.waitFor(isLoopMessage(session.id, 'paused'));

    client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
    const replayed = await client.waitFor(isLoopMessage(session.id, 'paused'), 10_000);
    expect(replayed.type).toBe('loop');
    await client.close();
  });

  it('WS: quem não assina a sessão não recebe a mudança do loop', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await workspaceId(daemon), agent: 'fake' });
    const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
    await putLoop(daemon, session.id, { prompt: 'checa', mode: 'interval', intervalMs: 3_600_000, runNow: false });
    client.send({ type: 'ping' });
    await client.waitFor((message) => message.type === 'pong');
    expect(client.messages.some((message) => isLoopMessage(session.id)(message))).toBe(false);
    await client.close();
  });

  it('reinício: o loop continua, e um disparo vencido roda logo depois de subir', async () => {
    const notices: Notice[] = [];
    const onNotify = (sessionId: string, kind: NotifyKind, details: NotifyDetails): void => {
      notices.push({ sessionId, kind, details });
    };
    const first = await startDaemon(env.home, { config: config(), onNotify });
    let firstOpen = true;
    let second: TestDaemon | undefined;
    try {
      const session = await createSession(first, { workspaceId: await workspaceId(first), agent: 'fake' });
      await putLoop(first, session.id, { prompt: 'depois do reinício', mode: 'interval', intervalMs: 30_000, runNow: false });
      // O disparo ficou no passado quando o daemon caiu.
      first.db.prepare('UPDATE loops SET next_run_at = ? WHERE session_id = ?').run(Date.now() - 1000, session.id);
      await stopDaemon(first);
      firstOpen = false;

      // Subida como no main.ts: sessões que estavam ativas viram stopped antes de o daemon escutar.
      const boot = openDatabase(join(env.home, 'data.db'));
      stopInterruptedSessions(boot, Date.now());
      boot.close();

      second = await startDaemon(env.home, { config: config(), onNotify });
      expect(loopOf(second, session.id)).toMatchObject({ state: 'active', prompt: 'depois do reinício' });
      // A sessão está parada: o disparo a retoma sozinho (session/load) e manda a iteração.
      await until(() => iterationsOf(second as TestDaemon, session.id).length === 1, 'iteração após reinício', 15_000);
      expect(iterationsOf(second, session.id)[0]?.iteration).toBe(1);
      await until(() => second !== undefined && statusOf(second, session.id) === 'idle', 'sessão idle após o disparo', 15_000);
      expect(await methodsOf(session.id)).toContain('session/load');
    } finally {
      if (firstOpen) await stopDaemon(first);
      if (second !== undefined) await stopDaemon(second);
    }
  }, 30_000);
});

function statusOf(daemon: TestDaemon, sessionId: string): string | undefined {
  return daemon.db.prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?').get(sessionId)?.status;
}

/** Métodos ACP que o daemon mandou ao agente desta sessão (todos os processos que ela subiu). */
async function methodsOf(sessionId: string): Promise<string[]> {
  const text = await readFile(join(pidDir, `${sessionId}.methods.jsonl`), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line))
    .filter((method): method is string => typeof method === 'string');
}

function isLoopMessage(sessionId: string, state?: Loop['state']): (message: ServerMessage) => boolean {
  return (message) =>
    message.type === 'loop' &&
    message.sessionId === sessionId &&
    (state === undefined || message.loop?.state === state);
}

