import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SessionSchema,
  ShellsResponseSchema,
  type ErrorResponse,
  type Session,
  type SessionEvent,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countBusySessions, insertWorkspace } from '../src/repository.js';
import { spawnTerminal } from '../src/pty-process.js';
import type { NotifyDetails, NotifyKind } from '../src/notify.js';
import { authHeader, listen, pairToken, WsTestClient } from './agent-support.js';
import { setupDaemonTests, startDaemon, type StartOptions, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/** Shell de teste: cmd.exe, que existe em qualquer Windows e não depende do perfil do PowerShell. */
const SHELL = 'cmd';
const TITLE = 'Terminal · cmd';
const LEAK_VAR = 'NANACHI_TEST_LEAK';

let base: string;
let workspace: string;
let previousLeak: string | undefined;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-shell-')));
  workspace = join(base, 'projeto');
  await mkdir(workspace);
  previousLeak = process.env[LEAK_VAR];
  process.env[LEAK_VAR] = 'segredo-do-daemon';
});

afterEach(async () => {
  if (previousLeak === undefined) delete process.env[LEAK_VAR];
  else process.env[LEAK_VAR] = previousLeak;
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach do vitest roda em pilha, então este roda por último
// (os daemons já mataram os shells, que mantêm o cwd dentro do workspace).
const env = setupDaemonTests();

/** Sobe um PTY de verdade (node-pty) e mata na hora. Sem ele, os testes de shell não rodam. */
function ptyAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const probe = spawnTerminal(
      { file: process.env.ComSpec ?? 'cmd.exe', args: [], shell: false },
      { cwd: tmpdir(), env: process.env, cols: 80, rows: 24 },
    );
    probe.kill();
    return true;
  } catch {
    return false;
  }
}

const SKIP = !ptyAvailable();

async function start(options: StartOptions = {}): Promise<TestDaemon> {
  return env.start({ ...options, config: { allowedRoots: [base], shellSessions: true, ...options.config } });
}

async function workspaceId(daemon: TestDaemon): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path: workspace },
  });
  return res.json<{ id: string }>().id;
}

async function createShell(daemon: TestDaemon, id: string): Promise<Session> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: await authHeader(daemon),
    payload: { workspaceId: id, agent: 'shell', shell: SHELL },
  });
  if (res.statusCode !== 201) throw new Error(`POST /api/sessions (shell) → ${res.statusCode}: ${res.body}`);
  return SessionSchema.parse(res.json<unknown>());
}

/** Cliente WS já inscrito na sessão (com replay). */
async function subscribe(daemon: TestDaemon, sessionId: string): Promise<WsTestClient> {
  const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId, afterSeq: 0 });
  await client.sync();
  return client;
}

/** Espera até `done` ser verdadeiro sobre os eventos já recebidos da sessão. */
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

async function getSession(daemon: TestDaemon, sessionId: string): Promise<Session> {
  const list = await daemon.app.inject({
    method: 'GET',
    url: `/api/workspaces/${await workspaceId(daemon)}/sessions`,
    headers: await authHeader(daemon),
  });
  const found = SessionSchema.array().parse(list.json<{ sessions: unknown[] }>().sessions).find((s) => s.id === sessionId);
  if (found === undefined) throw new Error(`sessão ${sessionId} não está na lista`);
  return found;
}

describe.skipIf(SKIP)('terminal de workspace (agent "shell")', () => {
  it('cria um PTY na pasta do workspace: kind pty, agent shell, título "Terminal · <shell>", running', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));

    expect(session).toMatchObject({ agent: 'shell', kind: 'pty', title: TITLE, status: 'running', worktree: null });
  });

  it('escreve e lê: o comando digitado roda e a saída chega como terminal_output', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'terminal_input', sessionId: session.id, data: 'set /a 6*7\r' });
    await until(client, session.id, (events) => outputOf(events).includes('42'));
    await client.close();
  });

  it('o cwd é a pasta do workspace', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'terminal_input', sessionId: session.id, data: 'echo %CD%\r' });
    await until(client, session.id, (events) => outputOf(events).toLowerCase().includes(workspace.toLowerCase()));
    await client.close();
  });

  it('o ambiente não leva variáveis NANACHI_* do daemon (nem tokens de agente)', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'terminal_input', sessionId: session.id, data: `set ${LEAK_VAR}\r` });
    await until(client, session.id, (events) => outputOf(events).includes('not defined'));
    expect(outputOf(client.eventsOf(session.id))).not.toContain('segredo-do-daemon');
    await client.close();
  });

  it('terminal_resize não gera erro', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'terminal_resize', sessionId: session.id, cols: 120, rows: 40 });
    await client.sync();
    expect(client.messages.some((message) => message.type === 'error')).toBe(false);
    await client.close();
  });

  it('exit: o shell sai sozinho → terminal_exit e status stopped', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'terminal_input', sessionId: session.id, data: 'exit\r' });
    await until(client, session.id, (events) => events.some((event) => event.kind === 'terminal_exit'));
    await until(client, session.id, hasStatus('stopped'));

    const exit = client.eventsOf(session.id).find((event) => event.kind === 'terminal_exit');
    expect(exit).toMatchObject({ kind: 'terminal_exit', exitCode: 0 });
    expect(exit).not.toHaveProperty('reason');
    expect((await getSession(daemon, session.id)).status).toBe('stopped');
    await client.close();
  });

  it('DELETE mata o shell e deixa a sessão stopped; input depois disso é recusado', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));
    const del = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}`,
      headers: await authHeader(daemon),
    });
    expect(del.statusCode).toBe(204);
    expect((await getSession(daemon, session.id)).status).toBe('stopped');

    const client = await subscribe(daemon, session.id);
    client.send({ type: 'terminal_input', sessionId: session.id, data: 'echo oi\r' });
    await client.waitFor((message) => message.type === 'error');
    await client.close();
  });

  it('um shell aberto não conta como sessão ocupada (não segura o reload)', async () => {
    const daemon = await start();
    await createShell(daemon, await workspaceId(daemon));
    expect(countBusySessions(daemon.db)).toBe(0);
  });

  it('não é retomável: resume → 409 not_resumable; prompt → erro com a mensagem de criar uma nova', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));
    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });

    const resume = await daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/resume`,
      headers: await authHeader(daemon),
    });
    expect(resume.statusCode).toBe(409);
    expect(resume.json<ErrorResponse>().error).toBe('not_resumable');

    const client = await subscribe(daemon, session.id);
    client.send({ type: 'prompt', sessionId: session.id, text: 'oi' });
    const error = await client.waitFor((message) => message.type === 'error');
    expect(error).toMatchObject({ type: 'error', message: expect.stringContaining('não pode ser retomada') });
    expect((await getSession(daemon, session.id)).status).toBe('stopped');
    await client.close();
  });

  it('prompt numa sessão de shell viva → not_acp; loop → 409 not_acp; uso → 400 usage_unsupported', async () => {
    const daemon = await start();
    const session = await createShell(daemon, await workspaceId(daemon));
    const client = await subscribe(daemon, session.id);

    client.send({ type: 'prompt', sessionId: session.id, text: 'oi' });
    const error = await client.waitFor((message) => message.type === 'error');
    expect(error).toMatchObject({ type: 'error', message: expect.stringContaining('terminal') });

    const loop = await daemon.app.inject({
      method: 'PUT',
      url: `/api/sessions/${session.id}/loop`,
      headers: await authHeader(daemon),
      payload: { prompt: 'repete', mode: 'dynamic' },
    });
    expect(loop.statusCode).toBe(409);
    expect(loop.json<ErrorResponse>().error).toBe('not_acp');

    const usage = await daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/usage`,
      headers: await authHeader(daemon),
    });
    expect(usage.statusCode).toBe(400);
    expect(usage.json<ErrorResponse>().error).toBe('usage_unsupported');
    await client.close();
  });

  it('a lista de shells traz cmd e exatamente um padrão quando há algum', async () => {
    const daemon = await start();
    const res = await daemon.app.inject({ method: 'GET', url: '/api/shells', headers: await authHeader(daemon) });
    const { shells } = ShellsResponseSchema.parse(res.json<unknown>());

    expect(shells.map((shell) => shell.id)).toContain('cmd');
    expect(shells.filter((shell) => shell.isDefault)).toHaveLength(1);
  });

  it('shellSessions: false → POST 403 shell_disabled e GET /api/shells vazio', async () => {
    const daemon = await start({ config: { shellSessions: false } });
    const id = await workspaceId(daemon);

    const create = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId: id, agent: 'shell', shell: SHELL },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json<ErrorResponse>().error).toBe('shell_disabled');

    const list = await daemon.app.inject({ method: 'GET', url: '/api/shells', headers: await authHeader(daemon) });
    expect(ShellsResponseSchema.parse(list.json<unknown>()).shells).toEqual([]);
  });

  it('workspace fora de allowedRoots é recusado na criação (403 outside_roots), sem sessão', async () => {
    const permitted = join(base, 'permitido');
    await mkdir(permitted);
    const daemon = await start({ config: { allowedRoots: [permitted] } });
    const id = 'ws-fora';
    insertWorkspace(daemon.db, { id, name: 'fora', path: workspace, createdAt: 1, muted: false });

    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId: id, agent: 'shell', shell: SHELL },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<ErrorResponse>().error).toBe('outside_roots');
    expect(daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sessions').get()?.n).toBe(0);
  });

  it('shell que não existe no PC → 400 shell_unavailable', async () => {
    const daemon = await start();
    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId: await workspaceId(daemon), agent: 'shell', shell: 'bash' },
    });
    // Git Bash só existe onde o Git for Windows está instalado: o teste aceita os dois resultados possíveis.
    if (res.statusCode === 201) {
      expect(SessionSchema.parse(res.json<unknown>()).title).toBe('Terminal · bash');
    } else {
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorResponse>().error).toBe('shell_unavailable');
    }
  });

  it('shell com outro agente, ou com resumeAcpSessionId, é recusado (400 invalid_request)', async () => {
    const daemon = await start();
    const id = await workspaceId(daemon);
    const withOtherAgent = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId: id, agent: 'omp', shell: SHELL },
    });
    expect(withOtherAgent.statusCode).toBe(400);
    const imported = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId: id, agent: 'shell', resumeAcpSessionId: 'x' },
    });
    expect(imported.statusCode).toBe(400);
  });

  it('reload: o shell recebe terminal_exit com reason "reload" e fica stopped, sem push', async () => {
    const notices: Array<{ kind: NotifyKind; details: NotifyDetails }> = [];
    const daemon = await start({ onNotify: (_s, kind, details) => notices.push({ kind, details }) });
    const session = await createShell(daemon, await workspaceId(daemon));
    const client = await subscribe(daemon, session.id);

    daemon.app.closeShellsForReload();
    await until(client, session.id, (events) => events.some((event) => event.kind === 'terminal_exit'));

    const exit = client.eventsOf(session.id).find((event) => event.kind === 'terminal_exit');
    expect(exit).toMatchObject({ kind: 'terminal_exit', exitCode: null, reason: 'reload' });
    expect((await getSession(daemon, session.id)).status).toBe('stopped');
    expect(notices).toEqual([]);
    await client.close();
  });
});
