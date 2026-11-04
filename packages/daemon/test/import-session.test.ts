import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSchema, type AgentConfig, type Session, type SessionEvent } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createWorkspace,
  fakeAgent,
  waitUntilDead,
  writeAgentStore,
  type StoredAgentSession,
} from './agent-support.js';
import { findAcpSessionId, listEvents } from '../src/repository.js';
import type { NotifyHandler, NotifyKind } from '../src/notify.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;
let store: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-import-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  store = join(base, 'agente.json');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach roda em pilha, então este roda por último.
const env = setupDaemonTests();

const ACP_ID = 'sessao-antiga';

function sessionFromStore(history: StoredAgentSession['history']): StoredAgentSession {
  return {
    sessionId: ACP_ID,
    cwd: workspace,
    title: 'Parser',
    updatedAt: '2026-11-02T10:00:00.000Z',
    history,
  };
}

const HISTORY: StoredAgentSession['history'] = [
  { role: 'user', text: 'oi, lembra do parser?' },
  { role: 'agent', text: 'Lembro.' },
  { role: 'agent', text: ' Vamos lá.' },
];

function agents(): Record<string, AgentConfig> {
  const storeEnv = { FAKE_AGENT_STORE: store, FAKE_AGENT_PID_DIR: pidDir };
  return {
    lista: fakeAgent(storeEnv),
    semretomar: fakeAgent({ ...storeEnv, FAKE_AGENT_RESUME: 'none' }),
    terminal: { ...fakeAgent(), kind: 'pty' },
  };
}

async function start(onNotify?: NotifyHandler): Promise<TestDaemon> {
  return env.start({ config: { allowedRoots: [base], agents: agents() }, onNotify });
}

interface NotifyCall {
  sessionId: string;
  kind: NotifyKind;
}

async function importSession(
  daemon: TestDaemon,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: await authHeader(daemon),
    payload: body,
  });
  return { status: res.statusCode, body: res.json<unknown>() };
}

async function importOk(daemon: TestDaemon, body: Record<string, unknown>): Promise<Session> {
  const { status, body: json } = await importSession(daemon, body);
  expect(status).toBe(201);
  return SessionSchema.parse(json);
}

async function stop(daemon: TestDaemon, sessionId: string): Promise<void> {
  const res = await daemon.app.inject({
    method: 'DELETE',
    url: `/api/sessions/${sessionId}`,
    headers: await authHeader(daemon),
  });
  expect(res.statusCode).toBe(204);
}

function eventsOf(daemon: TestDaemon, sessionId: string): SessionEvent[] {
  return listEvents(daemon.db, sessionId, 0, 100_000);
}

/** Eventos sem os de status (o que veio do agente e do usuário). */
function contentOf(daemon: TestDaemon, sessionId: string): SessionEvent[] {
  return eventsOf(daemon, sessionId).filter((event) => event.kind !== 'status');
}

describe('POST /api/sessions com resumeAcpSessionId (importar sessão do PC)', () => {
  it('grava o histórico reenviado pelo session/load como eventos, com título da listagem e sessão idle', async () => {
    const daemon = await start();
    await writeAgentStore(store, [sessionFromStore(HISTORY)]);
    const workspaceId = await createWorkspace(daemon, workspace);

    const session = await importOk(daemon, {
      workspaceId,
      agent: 'lista',
      resumeAcpSessionId: ACP_ID,
      resumeTitle: 'Parser',
    });

    expect(session).toMatchObject({ agent: 'lista', kind: 'acp', title: 'Parser', status: 'idle' });
    expect(findAcpSessionId(daemon.db, session.id)).toBe(ACP_ID);
    expect(contentOf(daemon, session.id).map((event) => event.kind)).toEqual([
      'user_message',
      'agent_message_chunk',
      'agent_message_chunk',
    ]);
    expect(contentOf(daemon, session.id)).toMatchObject([
      { kind: 'user_message', text: 'oi, lembra do parser?' },
      { kind: 'agent_message_chunk', text: 'Lembro.' },
      { kind: 'agent_message_chunk', text: ' Vamos lá.' },
    ]);
    const lastStatus = eventsOf(daemon, session.id).filter((event) => event.kind === 'status').at(-1);
    expect(lastStatus).toMatchObject({ kind: 'status', status: 'idle' });
  });

  it('sem resumeTitle o título vira "Sessão retomada"', async () => {
    const daemon = await start();
    await writeAgentStore(store, [sessionFromStore(HISTORY)]);
    const workspaceId = await createWorkspace(daemon, workspace);

    const session = await importOk(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });

    expect(session.title).toBe('Sessão retomada');
  });

  it('mensagens do usuário em chunks seguidos viram um único user_message', async () => {
    const daemon = await start();
    await writeAgentStore(store, [
      sessionFromStore([
        { role: 'user', text: 'parte 1' },
        { role: 'user', text: ' parte 2' },
        { role: 'agent', text: 'ok' },
      ]),
    ]);
    const workspaceId = await createWorkspace(daemon, workspace);

    const session = await importOk(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });

    expect(contentOf(daemon, session.id)).toMatchObject([
      { kind: 'user_message', text: 'parte 1 parte 2' },
      { kind: 'agent_message_chunk', text: 'ok' },
    ]);
  });

  it('aplica config depois do histórico (o modelo escolhido vale, não o padrão do agente)', async () => {
    const daemon = await start();
    await writeAgentStore(store, [sessionFromStore(HISTORY)]);
    const workspaceId = await createWorkspace(daemon, workspace);

    const session = await importOk(daemon, {
      workspaceId,
      agent: 'lista',
      resumeAcpSessionId: ACP_ID,
      config: { model: 'slow-model' },
    });

    expect(session.configOptions.find((option) => option.id === 'model')).toMatchObject({ currentValue: 'slow-model' });
  });

  it('segunda importação da mesma sessão com ela aberta → 409 already_running com o sessionId', async () => {
    const daemon = await start();
    await writeAgentStore(store, [sessionFromStore(HISTORY)]);
    const workspaceId = await createWorkspace(daemon, workspace);
    const first = await importOk(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });

    const second = await importSession(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });

    expect(second).toEqual({ status: 409, body: { error: 'already_running', sessionId: first.id } });
  });

  it('importar de novo depois de parar → 409 already_linked com o sessionId (o app abre e oferece Retomar)', async () => {
    const daemon = await start();
    await writeAgentStore(store, [sessionFromStore(HISTORY)]);
    const workspaceId = await createWorkspace(daemon, workspace);
    const first = await importOk(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });
    await stop(daemon, first.id);

    const second = await importSession(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });

    expect(second).toEqual({ status: 409, body: { error: 'already_linked', sessionId: first.id } });
  });

  it('histórico acima de 5000 eventos: grava 5000 e um error "histórico truncado" no ponto do corte', async () => {
    const daemon = await start();
    const long = Array.from({ length: 5_002 }, (_, index) => ({ role: 'agent' as const, text: `t${index}` }));
    await writeAgentStore(store, [sessionFromStore(long)]);
    const workspaceId = await createWorkspace(daemon, workspace);

    const session = await importOk(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });

    const content = contentOf(daemon, session.id);
    expect(content.filter((event) => event.kind === 'agent_message_chunk')).toHaveLength(5_000);
    const truncated = content.filter((event) => event.kind === 'error');
    expect(truncated).toEqual([
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('histórico truncado') }),
    ]);
    expect(content.at(-1)).toMatchObject({ kind: 'error' });
    expect(session.status).toBe('idle');
  }, 60_000);

  it('histórico truncado grava o aviso mas não chama onNotify (sem Web Push de erro na importação)', async () => {
    const calls: NotifyCall[] = [];
    const daemon = await start((sessionId, kind) => calls.push({ sessionId, kind }));
    const long = Array.from({ length: 5_002 }, (_, index) => ({ role: 'agent' as const, text: `t${index}` }));
    await writeAgentStore(store, [sessionFromStore(long)]);
    const workspaceId = await createWorkspace(daemon, workspace);

    const session = await importOk(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });

    expect(contentOf(daemon, session.id).filter((event) => event.kind === 'error')).toEqual([
      expect.objectContaining({ kind: 'error', message: expect.stringContaining('histórico truncado') }),
    ]);
    expect(calls).toEqual([]);
  }, 60_000);

  it('erro normal na importação continua chamando onNotify', async () => {
    const calls: NotifyCall[] = [];
    const daemon = await start((sessionId, kind) => calls.push({ sessionId, kind }));
    await writeAgentStore(store, [sessionFromStore(HISTORY)]);
    const workspaceId = await createWorkspace(daemon, workspace);

    const session = await importOk(daemon, { workspaceId, agent: 'semretomar', resumeAcpSessionId: ACP_ID });

    expect(session.status).toBe('error');
    expect(calls).toEqual([{ sessionId: session.id, kind: 'error' }]);
  });

  it('agente que não carrega nem retoma: a sessão nasce em error com a mensagem e o processo morre', async () => {
    const daemon = await start();
    await writeAgentStore(store, [sessionFromStore(HISTORY)]);
    const workspaceId = await createWorkspace(daemon, workspace);

    const session = await importOk(daemon, { workspaceId, agent: 'semretomar', resumeAcpSessionId: ACP_ID });

    expect(session.status).toBe('error');
    expect(contentOf(daemon, session.id)).toEqual([
      expect.objectContaining({ kind: 'error', message: 'agente não permite retomar sessões' }),
    ]);
    const pid = Number((await readFile(join(pidDir, `${session.id}.pid`), 'utf8')).trim());
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('agente de terminal (pty) → 409 not_resumable', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, workspace);

    const res = await importSession(daemon, { workspaceId, agent: 'terminal', resumeAcpSessionId: ACP_ID });

    expect(res).toEqual({ status: 409, body: { error: 'not_resumable' } });
  });

  it('worktree junto com resumeAcpSessionId → 400 (a sessão importada roda no cwd do workspace)', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, workspace);

    const res = await importSession(daemon, {
      workspaceId,
      agent: 'lista',
      resumeAcpSessionId: ACP_ID,
      worktree: true,
    });

    expect(res).toEqual({ status: 400, body: { error: 'invalid_request' } });
  });

  it('workspace inexistente → 404; agente desconhecido → 400', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, workspace);

    expect((await importSession(daemon, { workspaceId: 'nao-existe', agent: 'lista', resumeAcpSessionId: ACP_ID })).status).toBe(404);
    expect((await importSession(daemon, { workspaceId, agent: 'nao-existe', resumeAcpSessionId: ACP_ID })).status).toBe(400);
  });

  it('a retomada normal (POST /resume) continua descartando o replay do histórico', async () => {
    const daemon = await start();
    await writeAgentStore(store, [sessionFromStore(HISTORY)]);
    const workspaceId = await createWorkspace(daemon, workspace);
    const imported = await importOk(daemon, { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID });
    await stop(daemon, imported.id);
    const before = contentOf(daemon, imported.id).length;

    const res = await daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${imported.id}/resume`,
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(200);
    expect(SessionSchema.parse(res.json<unknown>()).status).toBe('idle');
    expect(contentOf(daemon, imported.id)).toHaveLength(before);
  });
});
