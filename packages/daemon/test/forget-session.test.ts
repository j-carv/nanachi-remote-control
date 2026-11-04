import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionsResponseSchema, SessionSchema, type AgentConfig, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  fakeAgent,
  isAlive,
  listen,
  pairToken,
  waitUntilDead,
  WsTestClient,
  writeAgentStore,
  type StoredAgentSession,
} from './agent-support.js';
import { findAcpSessionId, findFileById, findSessionById, listEvents } from '../src/repository.js';
import { saveFile } from '../src/files.js';
import { git, initRepo } from './git-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

let base: string;
let workspace: string;
let pidDir: string;
let store: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-forget-')));
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

const ACP_ID = 'sessao-do-pc';

function agents(): Record<string, AgentConfig> {
  const storeEnv = { FAKE_AGENT_STORE: store, FAKE_AGENT_PID_DIR: pidDir };
  return { fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }), lista: fakeAgent(storeEnv) };
}

async function start(): Promise<TestDaemon> {
  return env.start({ config: { allowedRoots: [base], agents: agents() } });
}

async function createWorkspace(daemon: TestDaemon, path = workspace): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path },
  });
  expect(res.statusCode).toBe(201);
  return (res.json<{ id: string }>()).id;
}

/** DELETE /api/sessions/:id com a query dada. Devolve o status. */
async function remove(daemon: TestDaemon, sessionId: string, query = ''): Promise<number> {
  const res = await daemon.app.inject({
    method: 'DELETE',
    url: `/api/sessions/${sessionId}${query}`,
    headers: await authHeader(daemon),
  });
  return res.statusCode;
}

/** Métodos ACP que o daemon mandou ao agente desta sessão (anotados pelo fixture). */
async function methodsSentTo(sessionId: string): Promise<string[]> {
  const file = join(pidDir, `${sessionId}.methods.jsonl`);
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8')).split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as string);
}

/** Uma linha de arquivo do celular, gravada como o upload faria (pasta `<home>/files/<sessionId>`). */
async function addFile(daemon: TestDaemon, sessionId: string): Promise<string> {
  const record = await saveFile(daemon.db, {
    root: join(daemon.home, 'files'),
    sessionId,
    direction: 'to_phone',
    rawName: 'print.png',
    rawMime: 'image/png',
    bytes: Buffer.from('png'),
  });
  return record.id;
}

async function importSession(daemon: TestDaemon, workspaceId: string): Promise<Session> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: await authHeader(daemon),
    payload: { workspaceId, agent: 'lista', resumeAcpSessionId: ACP_ID, resumeTitle: 'Do PC' },
  });
  expect(res.statusCode).toBe(201);
  return SessionSchema.parse(res.json<unknown>());
}

describe('DELETE /api/sessions/:id?forget=1', () => {
  it('sessão parada: apaga a linha, os eventos e os arquivos dela (e a pasta), sem tocar nas outras sessões', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake' });
    const other = await createSession(daemon, { workspaceId, agent: 'fake' });
    await remove(daemon, session.id);
    const fileId = await addFile(daemon, session.id);
    await addFile(daemon, other.id);
    expect(listEvents(daemon.db, session.id, 0, 100).length).toBeGreaterThan(0);
    expect(existsSync(join(daemon.home, 'files', session.id))).toBe(true);

    expect(await remove(daemon, session.id, '?forget=1')).toBe(204);

    expect(findSessionById(daemon.db, session.id)).toBeUndefined();
    expect(listEvents(daemon.db, session.id, 0, 100)).toEqual([]);
    expect(findFileById(daemon.db, fileId)).toBeUndefined();
    expect(existsSync(join(daemon.home, 'files', session.id))).toBe(false);
    expect(findSessionById(daemon.db, other.id)).toBeDefined();
    expect(listEvents(daemon.db, other.id, 0, 100).length).toBeGreaterThan(0);
    expect(existsSync(join(daemon.home, 'files', other.id))).toBe(true);
  });

  it('sessão viva: para o processo do agente antes de apagar, e o agente não recebe delete nem close', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspace(daemon), agent: 'fake' });
    const pid = Number((await readFile(join(pidDir, `${session.id}.pid`), 'utf8')).trim());
    expect(isAlive(pid)).toBe(true);

    expect(await remove(daemon, session.id, '?forget=1')).toBe(204);

    expect(await waitUntilDead(pid)).toBe(true);
    expect(findSessionById(daemon.db, session.id)).toBeUndefined();
    const methods = await methodsSentTo(session.id);
    expect(methods).toContain('initialize');
    expect(methods).not.toContain('session/delete');
    expect(methods).not.toContain('session/close');
  });

  it('não remove o worktree (só com removeWorktree=1)', async () => {
    const daemon = await start();
    initRepo(workspace);
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });
    const worktreePath = session.worktree?.path ?? '';
    expect(existsSync(worktreePath)).toBe(true);

    expect(await remove(daemon, session.id, '?forget=1')).toBe(204);

    expect(findSessionById(daemon.db, session.id)).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(true);
    expect(git(workspace, 'worktree', 'list')).toContain(worktreePath.replace(/\\/g, '/').split('/').pop() ?? '');
  });

  it('avisa os clientes WS inscritos com session_removed', async () => {
    const daemon = await start();
    const session = await createSession(daemon, { workspaceId: await createWorkspace(daemon), agent: 'fake' });
    const client = await WsTestClient.connect(await listen(daemon), await pairToken(daemon));
    client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
    await client.sync();

    expect(await remove(daemon, session.id, '?forget=1')).toBe(204);

    const message = await client.waitFor((m) => m.type === 'session_removed');
    expect(message).toEqual({ type: 'session_removed', sessionId: session.id });
    await client.close();
  });

  it('depois de remover: a sessão do PC volta na listagem sem linkedSessionId e pode ser importada de novo', async () => {
    const daemon = await start();
    const history: StoredAgentSession['history'] = [
      { role: 'user', text: 'oi' },
      { role: 'agent', text: 'olá' },
    ];
    await writeAgentStore(store, [{ sessionId: ACP_ID, cwd: workspace, title: 'Do PC', updatedAt: '2026-11-02T10:00:00.000Z', history }]);
    const workspaceId = await createWorkspace(daemon);
    const first = await importSession(daemon, workspaceId);
    expect(await remove(daemon, first.id, '?forget=1')).toBe(204);

    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/agent-sessions?agent=lista`,
      headers: await authHeader(daemon),
    });
    const listing = AgentSessionsResponseSchema.parse(res.json<unknown>());
    expect(listing.sessions).toEqual([
      expect.objectContaining({ acpSessionId: ACP_ID, linkedSessionId: null }),
    ]);

    const again = await importSession(daemon, workspaceId);
    expect(again.id).not.toBe(first.id);
    expect(findAcpSessionId(daemon.db, again.id)).toBe(ACP_ID);
    expect(listEvents(daemon.db, again.id, 0, 100).map((event) => event.kind)).toContain('user_message');
    expect(listEvents(daemon.db, first.id, 0, 100)).toEqual([]);
  });

  it('id desconhecido → 404 com forget=1', async () => {
    const daemon = await start();
    expect(await remove(daemon, 'nao-existe', '?forget=1')).toBe(404);
  });
});
