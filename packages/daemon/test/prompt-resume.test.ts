import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSchema, type AgentConfig, type Session, type ServerMessage, type SessionEvent } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  fakeAgent,
  isEvent,
  listen,
  pairToken,
  WsTestClient,
} from './agent-support.js';
import { insertSession, listEvents } from '../src/repository.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Prompt numa sessão parada: o daemon retoma sozinho (mesmo caminho do Retomar) antes de mandar o turno.
 * O fake agent grava os métodos que recebe em <pidDir>/<sessionId>.methods.jsonl e os prompts em .prompts.jsonl.
 */

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-prompt-resume-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach do vitest roda em pilha (ver resume.test.ts).
const env = setupDaemonTests();

function agents(): Record<string, AgentConfig> {
  const pid = { FAKE_AGENT_PID_DIR: pidDir };
  return {
    fake: fakeAgent(pid),
    // session/load demora 400 ms: a janela em que a retomada está em curso.
    lento: fakeAgent({ ...pid, FAKE_AGENT_LOAD_DELAY_MS: '400' }),
    falha: fakeAgent({ ...pid, FAKE_AGENT_LOAD_FAIL: '1' }),
    semretomar: fakeAgent({ ...pid, FAKE_AGENT_RESUME: 'none' }),
  };
}

async function start(): Promise<TestDaemon> {
  // Aviso do phone-send desligado: o eco do fake inclui o texto do prompt.
  return env.start({ config: { allowedRoots: [base], agents: agents(), phoneSendHint: false } });
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

/** Sessão criada e parada: já tem acp_session_id, como depois de um reinício do PC. */
async function stoppedSession(daemon: TestDaemon, agent: string): Promise<Session> {
  const session = await createSession(daemon, { workspaceId: await createWorkspaceId(daemon), agent });
  const res = await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });
  expect(res.statusCode).toBe(204);
  return session;
}

/** Cliente WS inscrito na sessão desde o seq 0. */
async function subscribe(daemon: TestDaemon, sessionId: string): Promise<WsTestClient> {
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId, afterSeq: 0 });
  await client.sync();
  return client;
}

function eventsOf(daemon: TestDaemon, sessionId: string): SessionEvent[] {
  return listEvents(daemon.db, sessionId, 0, 10_000);
}

/** Rótulos curtos da linha do tempo: `status:<status>` para status, o kind para o resto. */
function labelsOf(events: readonly SessionEvent[]): string[] {
  return events.map((event) => (event.kind === 'status' ? `status:${event.status}` : event.kind));
}

function statusOf(daemon: TestDaemon, sessionId: string): string | undefined {
  return daemon.db.prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?').get(sessionId)?.status;
}

/** Métodos ACP que o daemon mandou ao agente desta sessão, em ordem (todos os processos que ela subiu). */
async function methodsOf(sessionId: string): Promise<string[]> {
  const text = await readFile(join(pidDir, `${sessionId}.methods.jsonl`), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line))
    .filter((method): method is string => typeof method === 'string');
}

async function promptsOf(sessionId: string): Promise<unknown[]> {
  const text = await readFile(join(pidDir, `${sessionId}.prompts.jsonl`), 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line));
}

/** Espera o daemon mandar `method` ao agente da sessão: prova que a retomada já começou. */
async function waitForMethod(sessionId: string, method: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await methodsOf(sessionId)).includes(method)) {
    if (Date.now() > deadline) throw new Error(`o daemon não mandou ${method} a tempo`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isErrorFor = (sessionId: string) => (message: ServerMessage) =>
  message.type === 'error' && message.sessionId === sessionId;

describe('prompt em sessão parada', () => {
  it('retoma sozinho, manda o turno e a sessão volta a idle (starting, idle, depois o turno)', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'fake');
    const client = await subscribe(daemon, stopped.id);
    const stopIndex = eventsOf(daemon, stopped.id).length;

    client.send({ type: 'prompt', sessionId: stopped.id, text: 'continua' });
    await client.waitFor(isEvent('turn_end'));

    const after = labelsOf(eventsOf(daemon, stopped.id).slice(stopIndex));
    expect(after.slice(0, 4)).toEqual(['status:starting', 'status:idle', 'user_message', 'status:running']);
    expect(after.at(-1)).toBe('status:idle');
    expect(eventsOf(daemon, stopped.id).some((event) => event.kind === 'agent_message_chunk' && event.text === 'continua')).toBe(
      true,
    );
    expect(statusOf(daemon, stopped.id)).toBe('idle');
    await client.close();
  });

  it('uma retomada em curso não sobe um segundo agente: o segundo prompt espera a mesma e leva session_busy', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'lento');
    const client = await subscribe(daemon, stopped.id);

    client.send({ type: 'prompt', sessionId: stopped.id, text: 'primeiro' });
    await waitForMethod(stopped.id, 'session/load');
    client.send({ type: 'prompt', sessionId: stopped.id, text: 'segundo' });

    const busy = await client.waitFor(isErrorFor(stopped.id));
    expect(busy).toMatchObject({ type: 'error', message: 'sessão não está ociosa (status: running)' });
    await client.waitFor(isEvent('turn_end'));

    expect((await methodsOf(stopped.id)).filter((method) => method === 'session/load')).toHaveLength(1);
    expect(await promptsOf(stopped.id)).toHaveLength(1);
    const messages = eventsOf(daemon, stopped.id).filter((event) => event.kind === 'user_message');
    expect(messages.map((event) => (event.kind === 'user_message' ? event.text : ''))).toEqual(['primeiro']);
    await client.close();
  });

  it('prompt enquanto o Retomar manual está em curso espera a mesma retomada', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'lento');

    const manual = daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${stopped.id}/resume`,
      headers: await authHeader(daemon),
    });
    await waitForMethod(stopped.id, 'session/load');
    const client = await subscribe(daemon, stopped.id);
    client.send({ type: 'prompt', sessionId: stopped.id, text: 'depois do retomar' });

    expect((await manual).statusCode).toBe(200);
    await client.waitFor(isEvent('turn_end'));
    expect((await methodsOf(stopped.id)).filter((method) => method === 'session/load')).toHaveLength(1);
    expect(await promptsOf(stopped.id)).toHaveLength(1);
    await client.close();
  });

  it('falha da retomada vira o erro do prompt; nenhum user_message é gravado e a sessão fica com erro', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'falha');
    const client = await subscribe(daemon, stopped.id);

    client.send({ type: 'prompt', sessionId: stopped.id, text: 'não deve ser gravado' });
    const error = await client.waitFor(isErrorFor(stopped.id));

    expect(error).toMatchObject({ type: 'error', message: expect.stringContaining('falha simulada') });
    expect(eventsOf(daemon, stopped.id).some((event) => event.kind === 'user_message')).toBe(false);
    expect(eventsOf(daemon, stopped.id).some((event) => event.kind === 'error')).toBe(true);
    expect(statusOf(daemon, stopped.id)).toBe('error');
    expect(await promptsOf(stopped.id)).toHaveLength(0);
    await client.close();
  });

  it('agente que não retoma: erro claro, nenhum user_message e a sessão continua stopped', async () => {
    const daemon = await start();
    const stopped = await stoppedSession(daemon, 'semretomar');
    const client = await subscribe(daemon, stopped.id);

    client.send({ type: 'prompt', sessionId: stopped.id, text: 'x' });
    const error = await client.waitFor(isErrorFor(stopped.id));

    expect(error).toMatchObject({
      type: 'error',
      message: 'sessão encerrada e não pode ser retomada; crie uma nova',
    });
    expect(eventsOf(daemon, stopped.id).some((event) => event.kind === 'user_message')).toBe(false);
    expect(statusOf(daemon, stopped.id)).toBe('stopped');
    await client.close();
  });

  it('sessão de terminal (pty) parada: mesma mensagem clara, sem subir agente', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspaceId(daemon);
    insertSession(daemon.db, { id: 'terminal', workspaceId, agent: 'fake', kind: 'pty', title: 't', status: 'stopped', createdAt: 1 });
    const client = await subscribe(daemon, 'terminal');

    client.send({ type: 'prompt', sessionId: 'terminal', text: 'x' });
    const error = await client.waitFor(isErrorFor('terminal'));

    expect(error).toMatchObject({
      type: 'error',
      message: 'sessão encerrada e não pode ser retomada; crie uma nova',
    });
    expect(await methodsOf('terminal')).toEqual([]);
    expect(statusOf(daemon, 'terminal')).toBe('stopped');
    await client.close();
  });
});
