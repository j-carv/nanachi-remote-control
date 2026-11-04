import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionSchema, WorkspaceSchema, type AgentConfig, type Session, type SessionEvent } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { phoneSendBinDir } from '../src/agent-path.js';
import type { NotifyDetails, NotifyKind } from '../src/notify.js';
import { insertSession } from '../src/repository.js';
import {
  authHeader,
  createSession,
  fakeAgent,
  fetchConfigOptions,
  listen,
  pairToken,
  waitUntilDead,
  WsTestClient,
} from './agent-support.js';
import { setupDaemonTests, startDaemon, type StartOptions, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

const PTY_FIXTURE = fileURLToPath(new URL('./fixtures/pty-echo.mjs', import.meta.url));

let base: string;
let workspace: string;
let outDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-pty-')));
  workspace = join(base, 'projeto');
  outDir = join(base, 'saida');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach do vitest roda em pilha, então este roda por último
// (depois que os daemons já mataram os processos, que mantêm o cwd dentro do workspace).
const env = setupDaemonTests();

/** Terminal que sai sozinho ao receber uma linha (código 3), terminal que fica vivo, e um comando inexistente. */
function agents(): Record<string, AgentConfig> {
  const ptyEnv = { PTY_OUT_DIR: outDir };
  return {
    fake: fakeAgent(),
    term: { label: 'Terminal', command: process.execPath, args: [PTY_FIXTURE], env: ptyEnv, kind: 'pty' },
    espera: { label: 'Espera', command: process.execPath, args: [PTY_FIXTURE, 'espera'], env: ptyEnv, kind: 'pty' },
    sumido: { label: 'Sumido', command: 'nao-existe-terminal-xyz', args: [], env: {}, kind: 'pty' },
  };
}

async function start(options: StartOptions = {}): Promise<TestDaemon> {
  return env.start({ ...options, config: { allowedRoots: [base], agents: agents() } });
}

async function createWorkspaceId(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

/** Espera o arquivo que o processo de terminal escreve ao subir (o pid é o último). */
async function ptyPid(sessionId: string): Promise<number> {
  const file = join(outDir, `${sessionId}.pid`);
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error('terminal não escreveu o pid');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return Number(await readFile(file, 'utf8'));
}

/** Cliente WS inscrito na sessão desde o seq 0. */
async function subscribe(daemon: TestDaemon, sessionId: string): Promise<WsTestClient> {
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId, afterSeq: 0 });
  await client.sync();
  return client;
}

/** Espera até `done` ser verdadeiro sobre os eventos já recebidos da sessão (confere antes de esperar). */
async function until(client: WsTestClient, sessionId: string, done: (events: SessionEvent[]) => boolean): Promise<void> {
  while (!done(client.eventsOf(sessionId))) {
    await client.waitFor((message) => message.type === 'event' && message.event.sessionId === sessionId);
  }
}

const outputOf = (events: SessionEvent[]): string =>
  events.flatMap((event) => (event.kind === 'terminal_output' ? [event.data] : [])).join('');

const hasStatus =
  (status: Session['status']) =>
  (events: SessionEvent[]): boolean =>
    events.some((event) => event.kind === 'status' && event.status === status);

describe('terminal (sessão kind pty)', () => {
  it('sobe no cwd do workspace com o env dos agentes ACP; saída inicial vira terminal_output', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'espera' });
    expect(session).toMatchObject({ kind: 'pty', status: 'running' });
    expect(await fetchConfigOptions(daemon, session.id)).toEqual([]);

    const client = await subscribe(daemon, session.id);
    await until(client, session.id, (events) => outputOf(events).includes('pronto'));

    const seen = JSON.parse(await readFile(join(outDir, `${session.id}.env.json`), 'utf8')) as Record<string, string>;
    expect(seen.cwd).toBe(workspace);
    expect(seen.AGENT_SESSION_ID).toBe(session.id);
    expect(seen.NANACHI_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(seen.NANACHI_AGENT_TOKEN).toMatch(/\S{20,}/);
    expect(seen.PATH?.split(delimiter)[0]).toBe(phoneSendBinDir());
    await client.close();
  });

  it('terminal_resize não quebra; terminal_input ecoa, sai com 3 → terminal_exit, stopped e aviso', async () => {
    const notices: Array<{ sessionId: string; kind: NotifyKind; details: NotifyDetails }> = [];
    const daemon = await start({
      onNotify: (sessionId, kind, details) => notices.push({ sessionId, kind, details }),
    });
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'term' });
    const client = await subscribe(daemon, session.id);
    await until(client, session.id, (events) => outputOf(events).includes('pronto'));

    client.send({ type: 'terminal_resize', sessionId: session.id, cols: 100, rows: 30 });
    client.send({ type: 'terminal_input', sessionId: session.id, data: 'ola\r' });
    await until(client, session.id, (events) => events.some((event) => event.kind === 'terminal_exit'));
    await until(client, session.id, hasStatus('stopped'));

    const events = client.eventsOf(session.id);
    expect(outputOf(events)).toContain('eco: ola');
    expect(events.find((event) => event.kind === 'terminal_exit')).toMatchObject({ kind: 'terminal_exit', exitCode: 3 });
    expect(client.messages.some((message) => message.type === 'error')).toBe(false);

    const list = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${session.workspaceId}/sessions`,
      headers: await authHeader(daemon),
    });
    expect(SessionSchema.array().parse(list.json<{ sessions: unknown[] }>().sessions)[0]?.status).toBe('stopped');

    expect(notices).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        kind: 'turn_end',
        details: expect.objectContaining({ kind: 'terminal_exit' }),
      }),
    ]);
    await client.close();
  });

  it('comandos ACP numa sessão de terminal viram error (not_acp) e não gravam nada', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'espera' });
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'prompt', sessionId: session.id, text: 'oi' });
    client.send({ type: 'set_config', sessionId: session.id, configId: 'mode', value: 'plan' });
    client.send({ type: 'permission_response', sessionId: session.id, requestId: 'r', optionId: 'allow' });
    client.send({ type: 'cancel', sessionId: session.id });
    await client.sync();

    const errors = client.messages.flatMap((message) => (message.type === 'error' ? [message] : []));
    expect(errors).toHaveLength(4);
    for (const error of errors) {
      expect(error).toMatchObject({ type: 'error', sessionId: session.id });
      expect(error.message).toMatch(/terminal/);
    }
    expect(client.eventsOf(session.id).some((event) => event.kind === 'user_message')).toBe(false);
    await client.close();
  });

  it('terminal_input e terminal_resize numa sessão de agente ACP viram error (not_pty)', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'fake' });
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'terminal_input', sessionId: session.id, data: 'x' });
    client.send({ type: 'terminal_resize', sessionId: session.id, cols: 80, rows: 24 });
    await client.sync();

    const errors = client.messages.flatMap((message) => (message.type === 'error' ? [message] : []));
    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error.type === 'error' && error.sessionId === session.id)).toBe(true);
    await client.close();
  });

  it('terminal_input numa sessão de terminal parada → error', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'espera' });
    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'terminal_input', sessionId: session.id, data: 'x' });
    await client.sync();

    expect(client.messages.some((message) => message.type === 'error' && message.sessionId === session.id)).toBe(true);
    await client.close();
  });

  it('resume: vivo → 409 already_running; parado → 409 not_resumable', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'espera' });
    const headers = await authHeader(daemon);

    const alive = await daemon.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/resume`, headers });
    expect(alive.statusCode).toBe(409);
    expect(alive.json<unknown>()).toEqual({ error: 'already_running' });

    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers });
    const stopped = await daemon.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/resume`, headers });
    expect(stopped.statusCode).toBe(409);
    expect(stopped.json<unknown>()).toEqual({ error: 'not_resumable' });
  });

  it('DELETE da sessão mata o processo e deixa a sessão stopped', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'espera' });
    const pid = await ptyPid(session.id);

    const res = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}`,
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(204);
    expect(await waitUntilDead(pid)).toBe(true);
    const list = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${session.workspaceId}/sessions`,
      headers: await authHeader(daemon),
    });
    expect(SessionSchema.array().parse(list.json<{ sessions: unknown[] }>().sessions)[0]?.status).toBe('stopped');
  });

  it('apagar o workspace mata os terminais dele', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspaceId(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'espera' });
    const pid = await ptyPid(session.id);

    const res = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${workspaceId}`,
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(204);
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('fechar o daemon mata os terminais', async () => {
    const daemon = await startDaemon(env.home, { config: { allowedRoots: [base], agents: agents() } });
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'espera' });
    const pid = await ptyPid(session.id);

    await daemon.app.close();
    daemon.db.close();

    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('comando que não existe → 201 com sessão error e evento error (igual ao ACP)', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent: 'sumido' });

    expect(session).toMatchObject({ kind: 'pty', status: 'error' });
    const client = await subscribe(daemon, session.id);
    await until(client, session.id, (events) => events.some((event) => event.kind === 'error'));
    await client.close();
  });

  it('teto de 8 sessões vivas vale para terminal e agente', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspaceId(daemon);
    await createSession(daemon, { workspaceId, agent: 'espera' });
    for (let index = 0; index < 7; index++) {
      const isPty = index % 2 === 0;
      insertSession(daemon.db, {
        id: `viva-${index}`,
        workspaceId,
        agent: isPty ? 'term' : 'fake',
        kind: isPty ? 'pty' : 'acp',
        title: 'x',
        status: 'idle',
        createdAt: index,
      });
    }
    const headers = await authHeader(daemon);

    for (const agent of ['fake', 'term']) {
      const res = await daemon.app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { workspaceId, agent } });
      expect(res.statusCode).toBe(429);
      expect(res.json<unknown>()).toEqual({ error: 'too_many_sessions' });
    }
  });
});
