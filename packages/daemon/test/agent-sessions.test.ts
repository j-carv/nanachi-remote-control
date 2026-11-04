import { mkdir, mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionsResponseSchema, type AgentConfig, type AgentSessionsResponse } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createWorkspace,
  fakeAgent,
  writeAgentStore,
  type StoredAgentSession,
} from './agent-support.js';
import { insertSession, updateSession } from '../src/repository.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let other: string;
let store: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-list-')));
  workspace = join(base, 'projeto');
  other = join(base, 'outro');
  store = join(base, 'agente.json');
  await mkdir(workspace);
  await mkdir(other);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach roda em pilha, então este roda por último.
const env = setupDaemonTests();

const session = (
  sessionId: string,
  cwd: string,
  updatedAt: string | null,
  title: string | null = sessionId,
): StoredAgentSession => ({ sessionId, cwd, title, updatedAt, history: [] });

function agents(): Record<string, AgentConfig> {
  const storeEnv = { FAKE_AGENT_STORE: store };
  return {
    // Páginas de 2 sessões.
    lista: fakeAgent({ ...storeEnv, FAKE_AGENT_PAGE_SIZE: '2' }),
    // Como o codex-acp: toda página vem vazia (com nextCursor) antes do conteúdo.
    vazia: fakeAgent({ ...storeEnv, FAKE_AGENT_PAGE_SIZE: '2', FAKE_AGENT_EMPTY_PAGES: '1' }),
    semlista: fakeAgent({ FAKE_AGENT_LIST: 'none' }),
    trava: fakeAgent({ FAKE_AGENT_LIST: 'hang' }),
    terminal: { ...fakeAgent(), kind: 'pty' },
  };
}

async function start(options: { agentListTimeoutMs?: number } = {}): Promise<TestDaemon> {
  return env.start({ config: { allowedRoots: [base], agents: agents() }, ...options });
}

async function list(
  daemon: TestDaemon,
  query: { agent?: string; cursor?: string | undefined; workspaceId: string },
): Promise<{ status: number; body: unknown }> {
  const params = new URLSearchParams();
  if (query.agent !== undefined) params.set('agent', query.agent);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/workspaces/${query.workspaceId}/agent-sessions?${params.toString()}`,
    headers: await authHeader(daemon),
  });
  return { status: res.statusCode, body: res.json<unknown>() };
}

async function listOk(
  daemon: TestDaemon,
  query: { agent: string; cursor?: string | undefined; workspaceId: string },
): Promise<AgentSessionsResponse> {
  const { status, body } = await list(daemon, query);
  expect(status).toBe(200);
  return AgentSessionsResponseSchema.parse(body);
}

/**
 * Ordem do arquivo: c-outra, e-outra (pasta de fora), a-antiga, b-nova, d-sem-data (pasta do workspace).
 * Com páginas de 2: a página 0 é só de fora, a página 2 traz a e b, a página 4 traz d.
 */
async function seedStore(): Promise<void> {
  await writeAgentStore(store, [
    session('c-outra', other, '2026-11-03T00:00:00.000Z'),
    session('e-outra', other, '2026-11-01T00:00:00.000Z'),
    session('a-antiga', workspace, '2026-10-01T10:00:00.000Z', 'Antiga'),
    session('b-nova', workspace, '2026-11-02T10:00:00.000Z', 'Nova'),
    session('d-sem-data', workspace, null, null),
  ]);
}

describe('GET /api/workspaces/:id/agent-sessions', () => {
  it('lista só a pasta do workspace, por updatedAt desc, com cursor para a próxima página', async () => {
    const daemon = await start();
    await seedStore();
    const workspaceId = await createWorkspace(daemon, workspace);

    // Página 0 (só de fora) vem filtrada vazia: o daemon segue o cursor sozinho até a página 2.
    const body = await listOk(daemon, { agent: 'lista', workspaceId });

    expect(body.supported).toBe(true);
    expect(body.sessions.map((item) => item.acpSessionId)).toEqual(['b-nova', 'a-antiga']);
    expect(body.sessions[0]).toMatchObject({ title: 'Nova', updatedAt: Date.parse('2026-11-02T10:00:00.000Z') });
    expect(body.nextCursor).toBe('4-0');
  });

  it('o cursor devolvido leva à página seguinte; sessão sem data vem com updatedAt e título nulos', async () => {
    const daemon = await start();
    await seedStore();
    const workspaceId = await createWorkspace(daemon, workspace);

    const first = await listOk(daemon, { agent: 'lista', workspaceId });
    const second = await listOk(daemon, { agent: 'lista', workspaceId, cursor: first.nextCursor ?? undefined });

    expect(second.sessions).toEqual([
      { acpSessionId: 'd-sem-data', title: null, updatedAt: null, linkedSessionId: null },
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it('agente que devolve página vazia com nextCursor (codex) é seguido até achar a pasta', async () => {
    const daemon = await start();
    await seedStore();
    const workspaceId = await createWorkspace(daemon, workspace);

    const body = await listOk(daemon, { agent: 'vazia', workspaceId });

    expect(body.sessions.map((item) => item.acpSessionId)).toEqual(['b-nova', 'a-antiga']);
    expect(body.nextCursor).toBe('4-0');
  });

  it('no máximo 5 páginas por pedido: depois disso responde vazio com o cursor de onde parou', async () => {
    const daemon = await start();
    // 10 sessões de fora. Com páginas de 2 e uma vazia antes de cada, 5 buscas não chegam a nenhuma da pasta.
    await writeAgentStore(
      store,
      Array.from({ length: 10 }, (_, index) => session(`fora-${index}`, other, '2026-11-01T00:00:00.000Z')),
    );
    const workspaceId = await createWorkspace(daemon, workspace);

    const body = await listOk(daemon, { agent: 'vazia', workspaceId });

    expect(body).toEqual({ supported: true, sessions: [], nextCursor: '4-1' });
  });

  it('linkedSessionId aponta para a sessão do app que já usa aquele acpSessionId (aberta ou parada)', async () => {
    const daemon = await start();
    await seedStore();
    const workspaceId = await createWorkspace(daemon, workspace);
    insertSession(daemon.db, {
      id: 'app-1',
      workspaceId,
      agent: 'lista',
      title: 'Antiga no app',
      status: 'stopped',
      createdAt: 1,
    });
    updateSession(daemon.db, 'app-1', { acpSessionId: 'a-antiga' }, 2);

    const body = await listOk(daemon, { agent: 'lista', workspaceId });

    expect(body.sessions.find((item) => item.acpSessionId === 'a-antiga')?.linkedSessionId).toBe('app-1');
    expect(body.sessions.find((item) => item.acpSessionId === 'b-nova')?.linkedSessionId).toBeNull();
  });

  it('agente de terminal (pty) → supported false, sem subir processo', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, workspace);

    const body = await listOk(daemon, { agent: 'terminal', workspaceId });

    expect(body).toEqual({ supported: false, sessions: [], nextCursor: null });
  });

  it('agente que não anuncia sessionCapabilities.list → supported false', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, workspace);

    const body = await listOk(daemon, { agent: 'semlista', workspaceId });

    expect(body).toEqual({ supported: false, sessions: [], nextCursor: null });
  });

  it('agente que não responde a tempo → 504 agent_timeout (o limite de 30 s é encurtado no teste)', async () => {
    const daemon = await start({ agentListTimeoutMs: 2_000 });
    const workspaceId = await createWorkspace(daemon, workspace);

    const { status, body } = await list(daemon, { agent: 'trava', workspaceId });

    expect(status).toBe(504);
    expect(body).toEqual({ error: 'agent_timeout' });
  }, 20_000);

  it('segunda listagem do mesmo agente enquanto a primeira roda → 429 busy', async () => {
    const daemon = await start({ agentListTimeoutMs: 2_000 });
    const workspaceId = await createWorkspace(daemon, workspace);

    const first = list(daemon, { agent: 'trava', workspaceId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await list(daemon, { agent: 'trava', workspaceId });

    expect(second).toEqual({ status: 429, body: { error: 'busy' } });
    expect((await first).status).toBe(504);
  }, 20_000);

  it('a listagem não grava sessão nem ocupa vaga no teto', async () => {
    const daemon = await start();
    await seedStore();
    const workspaceId = await createWorkspace(daemon, workspace);

    await listOk(daemon, { agent: 'lista', workspaceId });

    const count = daemon.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sessions').get();
    expect(count?.n).toBe(0);
  });

  it('agent ausente → 400; agente desconhecido → 400 unknown_agent; workspace inexistente → 404', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, workspace);

    expect((await list(daemon, { workspaceId })).status).toBe(400);
    expect(await list(daemon, { agent: 'nao-existe', workspaceId })).toEqual({
      status: 400,
      body: { error: 'unknown_agent' },
    });
    expect(await list(daemon, { agent: 'lista', workspaceId: 'nao-existe' })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('exige Bearer de dispositivo', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, workspace);

    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/agent-sessions?agent=lista`,
    });

    expect(res.statusCode).toBe(401);
  });
});
