import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionDiffResponseSchema, SessionSchema, WorkspaceSchema, type AgentConfig, type Session } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeader, createSession, fakeAgent, waitUntilDead } from './agent-support.js';
import { git, initRepo, writeIn } from './git-support.js';
import { setupDaemonTests, type StartOptions, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

const PTY_FIXTURE = fileURLToPath(new URL('./fixtures/pty-echo.mjs', import.meta.url));

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-wt-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
  initRepo(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach do vitest roda em pilha, então este roda por último
// (depois que os daemons já mataram os agentes, que mantêm o cwd dentro do worktree).
const env = setupDaemonTests();

function agents(): Record<string, AgentConfig> {
  return {
    fake: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }),
    espera: { label: 'Terminal', command: process.execPath, args: [PTY_FIXTURE, 'espera'], env: { PTY_OUT_DIR: pidDir }, kind: 'pty' },
  };
}

async function start(options: StartOptions = {}): Promise<TestDaemon> {
  return env.start({ ...options, config: { allowedRoots: [base], agents: agents() } });
}

async function createWorkspace(daemon: TestDaemon, path = workspace): Promise<string> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: await authHeader(daemon),
    payload: { path },
  });
  return WorkspaceSchema.parse(res.json<unknown>()).id;
}

/** Pasta em que o processo do agente (ou terminal) disse que estava rodando. Espera o arquivo que ele grava ao subir. */
async function cwdOf(sessionId: string): Promise<string> {
  const file = join(pidDir, `${sessionId}.env.json`);
  const deadline = Date.now() + 10_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`processo não gravou ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('cwd' in raw) || typeof raw.cwd !== 'string') {
    throw new Error('env.json sem cwd');
  }
  return realpathSync.native(raw.cwd);
}

async function pidOf(sessionId: string): Promise<number> {
  return Number((await readFile(join(pidDir, `${sessionId}.pid`), 'utf8')).trim());
}

/** Worktree esperado: <home>/worktrees/<workspaceId>/<8 primeiros do id da sessão>. */
function worktreeDirOf(daemon: TestDaemon, workspaceId: string, session: Session): string {
  return join(daemon.home, 'worktrees', workspaceId, session.id.slice(0, 8));
}

async function deleteSession(daemon: TestDaemon, id: string, query = '') {
  return daemon.app.inject({
    method: 'DELETE',
    url: `/api/sessions/${id}${query}`,
    headers: await authHeader(daemon),
  });
}

describe('POST /api/sessions com worktree', () => {
  it('cria worktree e branch nanachi/<8>, e o agente roda dentro dele', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);

    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });

    const short = session.id.slice(0, 8);
    const expectedPath = worktreeDirOf(daemon, workspaceId, session);
    expect(session.worktree).toEqual({ path: expectedPath, branch: `nanachi/${short}` });
    expect(session.status).toBe('idle');
    expect(existsSync(expectedPath)).toBe(true);
    expect(git(workspace, 'branch', '--list', `nanachi/${short}`).trim()).toContain(`nanachi/${short}`);
    expect(git(workspace, 'worktree', 'list')).toContain(expectedPath.replace(/\\/g, '/').split('/').pop() ?? '');
    expect(await cwdOf(session.id)).toBe(realpathSync.native(expectedPath));
  });

  it('sem worktree (ou worktree false) a sessão roda no workspace e worktree vem null', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);

    const plain = await createSession(daemon, { workspaceId, agent: 'fake' });
    const explicit = await createSession(daemon, { workspaceId, agent: 'fake', worktree: false });

    expect(plain.worktree).toBeNull();
    expect(explicit.worktree).toBeNull();
    expect(await cwdOf(plain.id)).toBe(realpathSync.native(workspace));
  });

  it('terminal (pty) com worktree também roda no worktree', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);

    const session = await createSession(daemon, { workspaceId, agent: 'espera', worktree: true });

    expect(session.kind).toBe('pty');
    expect(session.worktree?.path).toBe(worktreeDirOf(daemon, workspaceId, session));
    expect(await cwdOf(session.id)).toBe(realpathSync.native(session.worktree?.path ?? ''));
  });

  it('workspace que não é git → 400 not_git e nenhuma sessão criada', async () => {
    const plain = join(base, 'solto');
    await mkdir(plain);
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, plain);

    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId, agent: 'fake', worktree: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: 'not_git' });
    const list = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers: await authHeader(daemon),
    });
    expect(list.json<{ sessions: unknown[] }>().sessions).toEqual([]);
  });

  it('repo sem commit → 400 no_commits', async () => {
    const empty = join(base, 'vazio');
    await mkdir(empty);
    initRepo(empty, { commit: false });
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon, empty);

    const res = await daemon.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: await authHeader(daemon),
      payload: { workspaceId, agent: 'fake', worktree: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: 'no_commits' });
  });

  it('diff da sessão olha o worktree, não o workspace', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });
    writeIn(session.worktree?.path ?? '', 'so-no-worktree.txt', 'x\n');
    writeIn(workspace, 'so-no-workspace.txt', 'y\n');

    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}/diff`,
      headers: await authHeader(daemon),
    });
    const diff = SessionDiffResponseSchema.parse(res.json<unknown>());

    expect(diff.files.map((file) => file.path)).toEqual(['so-no-worktree.txt']);
  });
});

describe('DELETE /api/sessions/:id?removeWorktree=1', () => {
  it('para a sessão, remove o worktree e apaga a branch (já mergeada)', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });
    const dir = worktreeDirOf(daemon, workspaceId, session);
    const branch = session.worktree?.branch ?? '';

    expect((await deleteSession(daemon, session.id, '?removeWorktree=1')).statusCode).toBe(204);

    expect(existsSync(dir)).toBe(false);
    expect(git(workspace, 'branch', '--list', branch).trim()).toBe('');
    expect(git(workspace, 'worktree', 'list')).not.toContain(branch);
    expect(await sessionStatus(daemon, session.id)).toBe('stopped');
    expect(await waitUntilDead(await pidOf(session.id))).toBe(true);
  });

  it('worktree sujo → 409 worktree_dirty; a sessão para do mesmo jeito e a pasta fica', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });
    const dir = worktreeDirOf(daemon, workspaceId, session);
    writeIn(dir, 'trabalho-nao-salvo.txt', 'x\n');

    const res = await deleteSession(daemon, session.id, '?removeWorktree=1');

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>()).toEqual({ error: 'worktree_dirty' });
    expect(await sessionStatus(daemon, session.id)).toBe('stopped');
    expect(existsSync(join(dir, 'trabalho-nao-salvo.txt'))).toBe(true);
  });

  it('branch com commit próprio: remove a pasta, mas a branch fica (git branch -d recusa)', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });
    const dir = worktreeDirOf(daemon, workspaceId, session);
    const branch = session.worktree?.branch ?? '';
    writeIn(dir, 'feito.txt', 'x\n');
    git(dir, 'add', 'feito.txt');
    git(dir, 'commit', '-q', '-m', 'feito');

    expect((await deleteSession(daemon, session.id, '?removeWorktree=1')).statusCode).toBe(204);

    expect(existsSync(dir)).toBe(false);
    expect(git(workspace, 'branch', '--list', branch)).toContain(branch);
  });

  it('sem removeWorktree a pasta do worktree fica', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });
    const dir = worktreeDirOf(daemon, workspaceId, session);

    expect((await deleteSession(daemon, session.id)).statusCode).toBe(204);

    expect(existsSync(dir)).toBe(true);
  });

  it('sessão sem worktree com removeWorktree=1 só para (204)', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake' });

    expect((await deleteSession(daemon, session.id, '?removeWorktree=1')).statusCode).toBe(204);
    expect(await sessionStatus(daemon, session.id)).toBe('stopped');
  });
});

describe('resume de sessão em worktree', () => {
  it('retoma com o cwd do worktree', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });
    expect((await deleteSession(daemon, session.id)).statusCode).toBe(204);

    const res = await daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/resume`,
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(200);
    expect(SessionSchema.parse(res.json<unknown>()).status).toBe('idle');
    expect(await cwdOf(session.id)).toBe(realpathSync.native(worktreeDirOf(daemon, workspaceId, session)));
  });

  it('se a pasta do worktree sumiu, a retomada termina em error com evento', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });
    const dir = worktreeDirOf(daemon, workspaceId, session);
    expect((await deleteSession(daemon, session.id)).statusCode).toBe(204);
    await rm(dir, { recursive: true, force: true });

    const res = await daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/resume`,
      headers: await authHeader(daemon),
    });

    expect(res.statusCode).toBe(200);
    expect(SessionSchema.parse(res.json<unknown>()).status).toBe('error');
    const errors = daemon.db
      .prepare<[string], { payload: string }>("SELECT payload FROM events WHERE session_id = ? AND kind = 'error'")
      .all(session.id);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.at(-1)?.payload).toContain('não existe mais');
  });
});

describe('Session.worktree na API', () => {
  it('a lista de sessões do workspace traz o worktree gravado', async () => {
    const daemon = await start();
    const workspaceId = await createWorkspace(daemon);
    const session = await createSession(daemon, { workspaceId, agent: 'fake', worktree: true });

    const res = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers: await authHeader(daemon),
    });

    const listed = res.json<{ sessions: Session[] }>().sessions.find((item) => item.id === session.id);
    expect(listed?.worktree).toEqual(session.worktree);
  });
});

async function sessionStatus(daemon: TestDaemon, id: string): Promise<string> {
  const row = daemon.db
    .prepare<[string], { status: string }>('SELECT status FROM sessions WHERE id = ?')
    .get(id);
  return row?.status ?? 'ausente';
}

