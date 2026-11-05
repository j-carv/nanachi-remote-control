import { existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentProfileSchema,
  ResetRedeemResponseSchema,
  ResetsResponseSchema,
  SessionSchema,
  UsageResponseSchema,
  type AgentConfig,
  type ResetsResponse,
  type Session,
  type SessionEvent,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifyKind } from '../src/notify.js';
import { saveIdleSessionsForReload, takeResumeAfterReload } from '../src/reload-resume.js';
import {
  findSessionById,
  insertSession,
  listEvents,
  listSessionsByWorkspace,
  stopInterruptedSessions,
} from '../src/repository.js';
import {
  authHeader,
  createWorkspace,
  fakeAgent,
  isAlive,
  isEvent,
  listen,
  pairToken,
  waitUntilDead,
  WsTestClient,
  writeAgentStore,
} from './agent-support.js';
import { setupDaemonTests, startDaemon, stopDaemon, type StartOptions, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Contas nas sessões (PLAN.md, várias contas por agente): POST /api/sessions com accountId, PUT /api/sessions/:id/account,
 * o env que o agente recebe, o processo de uso e os resets por conta, a retomada depois do reload e a remoção da conta.
 * Os agentes `claude`, `codex` e `omp` do config são o fake agent: o id é o que liga o adaptador de contas. As pastas
 * principais ficam em pastas temporárias (CLAUDE_CONFIG_DIR / CODEX_HOME no env do agente) e `userHome` também: nada
 * toca o %USERPROFILE% de verdade.
 */

const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

let base: string;
let workspace: string;
let pidDir: string;
let principalClaude: string;
let principalCodex: string;
let userHome: string;
let codexEnvFile: string;
let store: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-session-accounts-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  principalClaude = join(base, 'principal-claude');
  principalCodex = join(base, 'principal-codex');
  userHome = join(base, 'user-home');
  codexEnvFile = join(base, 'codex-env.jsonl');
  store = join(base, 'agente.json');
  await mkdir(workspace);
  // The principal folders exist, as they do where the agents have run: Nanachi never creates them.
  await mkdir(principalClaude, { recursive: true });
  await mkdir(principalCodex, { recursive: true });
});

afterEach(async () => {
  await removeTempDir(base);
});

// Registrado antes do setupDaemonTests: o afterEach roda em pilha, então este roda por último.
const env = setupDaemonTests();

const clients: WsTestClient[] = [];
const extraDaemons: TestDaemon[] = [];

// Depois do setupDaemonTests: roda antes dele (fecha os clientes e os daemons manuais antes de apagar a pasta).
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const daemon of extraDaemons.splice(0)) await stopDaemon(daemon).catch(() => undefined);
});

interface BootOptions {
  /** Env a mais do agente claude. */
  claudeEnv?: Record<string, string>;
  /** false: o config do claude não define CLAUDE_CONFIG_DIR (a principal é o que o daemon tiver). */
  claudeHome?: boolean;
  codexEnv?: Record<string, string>;
  ompEnv?: Record<string, string>;
  /** Env of the daemon as the accounts code sees it (default: empty). */
  daemonEnv?: NodeJS.ProcessEnv;
  usageCacheMs?: number;
  usageTimeoutMs?: number;
  shellSessions?: boolean;
}

interface Notice {
  sessionId: string;
  kind: NotifyKind;
}

interface Rig {
  daemon: TestDaemon;
  workspaceId: string;
  headers: { authorization: string };
  /** Avisos (push) que o daemon emitiu. */
  notices: Notice[];
}

function configFor(options: BootOptions): Record<string, unknown> {
  const pid = { FAKE_AGENT_PID_DIR: pidDir };
  const agents: Record<string, AgentConfig> = {
    claude: fakeAgent({
      ...pid,
      ...(options.claudeHome === false ? {} : { CLAUDE_CONFIG_DIR: principalClaude }),
      ...options.claudeEnv,
    }),
    codex: fakeAgent({
      ...pid,
      CODEX_HOME: principalCodex,
      CODEX_PATH: CODEX_FIXTURE,
      FAKE_CODEX_ENV_FILE: codexEnvFile,
      ...options.codexEnv,
    }),
    omp: fakeAgent({ ...pid, ...options.ompEnv }),
  };
  return { allowedRoots: [base], agents, ...(options.shellSessions === true ? { shellSessions: true } : {}) };
}

/** Ajustes do daemon: contas com a pasta do usuário e o env do daemon sob o controle do teste. */
function startOptions(options: BootOptions): StartOptions {
  return {
    config: configFor(options),
    accountRuntime: { userHome, daemonEnv: options.daemonEnv ?? {} },
    usageCacheMs: options.usageCacheMs ?? 0,
    usageTimeoutMs: options.usageTimeoutMs,
  };
}

async function boot(options: BootOptions = {}): Promise<Rig> {
  const notices: Notice[] = [];
  const daemon = await env.start({
    ...startOptions(options),
    onNotify: (sessionId, kind) => {
      notices.push({ sessionId, kind });
    },
  });
  const workspaceId = await createWorkspace(daemon, workspace);
  return { daemon, workspaceId, headers: await authHeader(daemon), notices };
}

interface Reply {
  status: number;
  body: unknown;
}

async function http(rig: Rig, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Reply> {
  const res = await rig.daemon.app.inject({
    method,
    url,
    headers: rig.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.body === '' ? undefined : res.json<unknown>() };
}

async function addAccount(rig: Rig, agent: string, label = 'Trabalho'): Promise<string> {
  const reply = await http(rig, 'POST', `/api/agents/${agent}/accounts`, { label });
  expect(reply.status).toBe(201);
  return AgentProfileSchema.parse(reply.body).id;
}

async function setActive(rig: Rig, agent: string, accountId: string): Promise<void> {
  expect((await http(rig, 'PUT', `/api/agents/${agent}/accounts/active`, { accountId })).status).toBe(200);
}

function profileHome(rig: Rig, agent: string, accountId: string): string {
  return join(rig.daemon.home, 'accounts', agent, accountId);
}

/** POST /api/sessions e espera 201. */
async function newSession(rig: Rig, agent: string, accountId?: string): Promise<Session> {
  const reply = await http(rig, 'POST', '/api/sessions', {
    workspaceId: rig.workspaceId,
    agent,
    ...(accountId === undefined ? {} : { accountId }),
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return SessionSchema.parse(reply.body);
}

async function putAccount(rig: Rig, sessionId: string, payload: unknown): Promise<Reply> {
  return http(rig, 'PUT', `/api/sessions/${sessionId}/account`, payload);
}

interface RecordedEnv {
  cwd: string;
  CLAUDE_CONFIG_DIR: string | undefined;
  CODEX_HOME: string | undefined;
}

/** Env que o processo mais recente da chave (id da sessão, ou id do processo de uso) recebeu: o fake agent o grava ao subir. */
async function recordedEnv(key: string): Promise<RecordedEnv> {
  const raw: unknown = JSON.parse(await readFile(join(pidDir, `${key}.env.json`), 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error('env gravado inválido');
  const record: Record<string, unknown> = { ...raw };
  const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  return { cwd: String(record.cwd), CLAUDE_CONFIG_DIR: text(record.CLAUDE_CONFIG_DIR), CODEX_HOME: text(record.CODEX_HOME) };
}

async function pidOf(key: string): Promise<number> {
  return Number((await readFile(join(pidDir, `${key}.pid`), 'utf8')).trim());
}

async function methodsOf(sessionId: string): Promise<string[]> {
  const text = await readFile(join(pidDir, `${sessionId}.methods.jsonl`), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => String(JSON.parse(line)));
}

function eventsOf(rig: Rig, sessionId: string): SessionEvent[] {
  return listEvents(rig.daemon.db, sessionId, 0, 10_000);
}

function accountEvents(rig: Rig, sessionId: string): Array<{ accountId: string | null; label: string }> {
  return eventsOf(rig, sessionId).flatMap((event) =>
    event.kind === 'account_changed' ? [{ accountId: event.accountId, label: event.label }] : [],
  );
}

/** Status gravados depois do último `account_changed` da sessão, na ordem. */
function statusesAfterAccountChange(rig: Rig, sessionId: string): string[] {
  const events = eventsOf(rig, sessionId);
  const at = events.map((event) => event.kind).lastIndexOf('account_changed');
  return events.slice(at + 1).flatMap((event) => (event.kind === 'status' ? [event.status] : []));
}

async function connect(rig: Rig): Promise<WsTestClient> {
  const client = await WsTestClient.connect(await listen(rig.daemon), await pairToken(rig.daemon));
  clients.push(client);
  return client;
}

async function subscribe(client: WsTestClient, sessionId: string): Promise<void> {
  client.send({ type: 'subscribe', sessionId, afterSeq: 0 });
  await client.sync();
}

/** Manda um prompt e devolve o que o agente respondeu a ele (os chunks depois da última mensagem do usuário). */
async function ask(client: WsTestClient, sessionId: string, text: string): Promise<string> {
  client.send({ type: 'prompt', sessionId, text });
  await client.waitFor(isEvent('turn_end'));
  const events = client.eventsOf(sessionId);
  const lastUser = events.map((event) => event.kind).lastIndexOf('user_message');
  return events
    .slice(lastUser + 1)
    .flatMap((event) => (event.kind === 'agent_message_chunk' ? [event.text] : []))
    .join('');
}

/** Sessão no banco sem processo (para os testes que só leem a linha: resets, status ocupado). */
function insertRow(rig: Rig, input: { id: string; agent: string; status: Session['status']; accountId?: string | null }): void {
  insertSession(rig.daemon.db, {
    id: input.id,
    workspaceId: rig.workspaceId,
    agent: input.agent,
    title: 'Sessão de teste',
    status: input.status,
    createdAt: Date.now(),
    accountId: input.accountId ?? null,
  });
}

describe('POST /api/sessions: conta da sessão', () => {
  it('sem accountId e sem conta ativa: principal; o agente recebe a pasta do config e nenhuma pasta de perfil nasce', async () => {
    const rig = await boot();

    const session = await newSession(rig, 'claude');

    expect(session.accountId).toBeNull();
    expect((await recordedEnv(session.id)).CLAUDE_CONFIG_DIR).toBe(principalClaude);
    expect(existsSync(join(rig.daemon.home, 'accounts'))).toBe(false);
  });

  it('principal sem CLAUDE_CONFIG_DIR no config: o agente não recebe pasta de conta (fica o que o daemon já tem)', async () => {
    const rig = await boot({ claudeHome: false });

    const session = await newSession(rig, 'claude');

    expect(session.accountId).toBeNull();
    expect((await recordedEnv(session.id)).CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });

  it('accountId de conta extra: é gravado e o agente recebe a pasta do perfil, já preparada', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude');

    const session = await newSession(rig, 'claude', accountId);

    expect(session.accountId).toBe(accountId);
    expect(findSessionById(rig.daemon.db, session.id)?.accountId).toBe(accountId);
    const profile = profileHome(rig, 'claude', accountId);
    expect((await recordedEnv(session.id)).CLAUDE_CONFIG_DIR).toBe(profile);
    expect((await lstat(join(profile, 'projects'))).isSymbolicLink()).toBe(true);
    expect(listSessionsByWorkspace(rig.daemon.db, rig.workspaceId).map((item) => item.accountId)).toEqual([accountId]);
  });

  it('codex: a conta extra vai em CODEX_HOME', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'codex', 'Pessoal');

    const session = await newSession(rig, 'codex', accountId);

    const recorded = await recordedEnv(session.id);
    expect(recorded.CODEX_HOME).toBe(profileHome(rig, 'codex', accountId));
    expect(recorded.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
  });

  it('sem accountId vale a conta ativa do agente (só a do agente); default explícito é a principal', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude');
    await setActive(rig, 'claude', accountId);

    const active = await newSession(rig, 'claude');
    const explicitDefault = await newSession(rig, 'claude', 'default');
    const otherAgent = await newSession(rig, 'codex');

    expect(active.accountId).toBe(accountId);
    expect((await recordedEnv(active.id)).CLAUDE_CONFIG_DIR).toBe(profileHome(rig, 'claude', accountId));
    expect(explicitDefault.accountId).toBeNull();
    expect((await recordedEnv(explicitDefault.id)).CLAUDE_CONFIG_DIR).toBe(principalClaude);
    expect(otherAgent.accountId).toBeNull();
  });

  it('conta desconhecida, ou de outro agente → 400 invalid_request e nenhuma sessão nasce', async () => {
    const rig = await boot();
    const codexAccount = await addAccount(rig, 'codex');

    for (const accountId of ['fantasma', codexAccount]) {
      const reply = await http(rig, 'POST', '/api/sessions', { workspaceId: rig.workspaceId, agent: 'claude', accountId });
      expect(reply).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(listSessionsByWorkspace(rig.daemon.db, rig.workspaceId)).toEqual([]);
  });

  it('agente sem contas extras: conta que não é a principal → 400 accounts_unsupported; default e ausente passam', async () => {
    const rig = await boot();

    const refused = await http(rig, 'POST', '/api/sessions', { workspaceId: rig.workspaceId, agent: 'omp', accountId: 'qualquer' });
    expect(refused).toEqual({ status: 400, body: { error: 'accounts_unsupported' } });
    expect(listSessionsByWorkspace(rig.daemon.db, rig.workspaceId)).toEqual([]);

    expect((await newSession(rig, 'omp', 'default')).accountId).toBeNull();
    expect((await newSession(rig, 'omp')).accountId).toBeNull();
  });

  it('terminal de workspace com conta que não é a principal → 400 accounts_unsupported', async () => {
    const rig = await boot({ shellSessions: true });

    const reply = await http(rig, 'POST', '/api/sessions', { workspaceId: rig.workspaceId, agent: 'shell', accountId: 'x' });

    expect(reply).toEqual({ status: 400, body: { error: 'accounts_unsupported' } });
  });

  it('Retomar do PC (importar sessão): usa a conta ativa, ou a pedida', async () => {
    const stored = ['antiga-1', 'antiga-2'].map((sessionId) => ({
      sessionId,
      cwd: workspace,
      title: 'Parser',
      updatedAt: '2026-11-02T10:00:00.000Z',
      history: [],
    }));
    await writeAgentStore(store, stored);
    const rig = await boot({ claudeEnv: { FAKE_AGENT_STORE: store } });
    const accountId = await addAccount(rig, 'claude');
    await setActive(rig, 'claude', accountId);

    const imported = await http(rig, 'POST', '/api/sessions', {
      workspaceId: rig.workspaceId,
      agent: 'claude',
      resumeAcpSessionId: 'antiga-1',
    });
    expect(imported.status).toBe(201);
    const session = SessionSchema.parse(imported.body);
    expect(session.accountId).toBe(accountId);
    expect((await recordedEnv(session.id)).CLAUDE_CONFIG_DIR).toBe(profileHome(rig, 'claude', accountId));

    const asked = await http(rig, 'POST', '/api/sessions', {
      workspaceId: rig.workspaceId,
      agent: 'claude',
      resumeAcpSessionId: 'antiga-2',
      accountId: 'default',
    });
    expect(asked.status).toBe(201);
    const principal = SessionSchema.parse(asked.body);
    expect(principal.accountId).toBeNull();
    expect((await recordedEnv(principal.id)).CLAUDE_CONFIG_DIR).toBe(principalClaude);

    const refused = await http(rig, 'POST', '/api/sessions', {
      workspaceId: rig.workspaceId,
      agent: 'claude',
      resumeAcpSessionId: 'antiga-1',
      accountId: 'fantasma',
    });
    expect(refused).toEqual({ status: 400, body: { error: 'invalid_request' } });
  });
});

describe('pasta principal herdada de uma conta extra (env sujo)', () => {
  it('CLAUDE_CONFIG_DIR do config dentro de accounts é ignorado: o agente da principal não recebe essa pasta', async () => {
    const polluted = join(env.home, 'accounts', 'claude', 'outra-conta');
    const rig = await boot({ claudeHome: false, claudeEnv: { CLAUDE_CONFIG_DIR: polluted } });

    const session = await newSession(rig, 'claude');

    const received = (await recordedEnv(session.id)).CLAUDE_CONFIG_DIR;
    expect(received).not.toBe(polluted);
    expect(received ?? '').not.toContain('accounts');
  });

  it('a conta extra se prepara a partir da pasta padrão, e não de uma variável herdada que aponta para o próprio perfil', async () => {
    await mkdir(join(userHome, '.claude', 'projects'), { recursive: true });
    await writeFile(join(userHome, '.claude', 'projects', 'p.jsonl'), 'principal');
    const polluted = join(env.home, 'accounts', 'claude', 'qualquer');
    const rig = await boot({ claudeHome: false, daemonEnv: { CLAUDE_CONFIG_DIR: polluted } });

    const accountId = await addAccount(rig, 'claude');
    const session = await newSession(rig, 'claude', accountId);
    const principal = await newSession(rig, 'claude');

    expect(await readFile(join(profileHome(rig, 'claude', accountId), 'projects', 'p.jsonl'), 'utf8')).toBe('principal');
    expect((await recordedEnv(session.id)).CLAUDE_CONFIG_DIR).toBe(profileHome(rig, 'claude', accountId));
    expect((await recordedEnv(principal.id)).CLAUDE_CONFIG_DIR ?? '').not.toContain('accounts');
  });

  it('CODEX_HOME sujo: o app-server dos resets da principal sobe sem ele', async () => {
    const polluted = join(env.home, 'accounts', 'codex', 'outra-conta');
    const rig = await boot({ codexEnv: { CODEX_HOME: polluted }, daemonEnv: { CODEX_HOME: polluted } });
    const session = await newSession(rig, 'codex');

    await listResets(rig, session.id);

    expect(await codexHomesSeen()).toEqual([null]);
  });
});

describe('variáveis de ambiente com outra grafia (Windows)', () => {
  it.skipIf(process.platform !== 'win32')('o env do agente vence a variável do daemon mesmo escrita com outra caixa', async () => {
    process.env.ZZ_CASE_PROBE = 'daemon';
    try {
      const rig = await boot({ claudeEnv: { Zz_Case_Probe: 'agent' } });
      const session = await newSession(rig, 'claude');
      const client = await connect(rig);
      await subscribe(client, session.id);

      expect(await ask(client, session.id, '/env ZZ_CASE_PROBE')).toBe('ZZ_CASE_PROBE=agent');
    } finally {
      delete process.env.ZZ_CASE_PROBE;
    }
  });
});

describe('PUT /api/sessions/:id/account', () => {
  it('sessão ociosa: grava a conta e o evento, para o agente sem push e o retoma (session/load) com o env novo', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude', 'Trabalho');
    const session = await newSession(rig, 'claude');
    const oldPid = await pidOf(session.id);
    expect(await methodsOf(session.id)).not.toContain('session/load');

    const reply = await putAccount(rig, session.id, { accountId });

    expect(reply.status).toBe(200);
    expect(SessionSchema.parse(reply.body)).toMatchObject({ id: session.id, accountId, status: 'idle' });
    expect(findSessionById(rig.daemon.db, session.id)?.accountId).toBe(accountId);
    expect(accountEvents(rig, session.id)).toEqual([{ accountId, label: 'Trabalho' }]);
    expect(statusesAfterAccountChange(rig, session.id)).toEqual(['stopped', 'starting', 'idle']);

    expect(await waitUntilDead(oldPid)).toBe(true);
    const newPid = await pidOf(session.id);
    expect(newPid).not.toBe(oldPid);
    expect(isAlive(newPid)).toBe(true);
    expect((await recordedEnv(session.id)).CLAUDE_CONFIG_DIR).toBe(profileHome(rig, 'claude', accountId));
    expect(await methodsOf(session.id)).toContain('session/load');
    // Parar o agente para trocar a conta não é um acontecimento para o celular: nenhum aviso.
    expect(rig.notices).toEqual([]);
  });

  it('o agente da conta nova responde ao prompt seguinte, e voltar para default devolve a pasta principal', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude', 'Trabalho');
    const session = await newSession(rig, 'claude');
    const client = await connect(rig);
    await subscribe(client, session.id);

    expect((await putAccount(rig, session.id, { accountId })).status).toBe(200);
    expect(await ask(client, session.id, '/env CLAUDE_CONFIG_DIR')).toBe(
      `CLAUDE_CONFIG_DIR=${profileHome(rig, 'claude', accountId)}`,
    );

    const back = await putAccount(rig, session.id, { accountId: 'default' });
    expect(back.status).toBe(200);
    expect(SessionSchema.parse(back.body)).toMatchObject({ accountId: null, status: 'idle' });
    expect(accountEvents(rig, session.id)).toEqual([
      { accountId, label: 'Trabalho' },
      { accountId: null, label: 'Principal' },
    ]);
    expect(await ask(client, session.id, '/env CLAUDE_CONFIG_DIR')).toBe(`CLAUDE_CONFIG_DIR=${principalClaude}`);
  });

  it('mesma conta: 200 sem mudar nada (mesmo processo, nenhum evento)', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude');
    const session = await newSession(rig, 'claude', accountId);
    const pid = await pidOf(session.id);
    const before = eventsOf(rig, session.id).length;

    const same = await putAccount(rig, session.id, { accountId });
    expect(same.status).toBe(200);
    expect(SessionSchema.parse(same.body)).toMatchObject({ accountId, status: 'idle' });
    const principal = await newSession(rig, 'claude');
    expect((await putAccount(rig, principal.id, { accountId: 'default' })).status).toBe(200);

    expect(await pidOf(session.id)).toBe(pid);
    expect(isAlive(pid)).toBe(true);
    expect(eventsOf(rig, session.id)).toHaveLength(before);
    expect(accountEvents(rig, principal.id)).toEqual([]);
  });

  it('agente trabalhando → 409 session_busy, e nada muda (nem a conta, nem o processo)', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude');
    const session = await newSession(rig, 'claude');
    const pid = await pidOf(session.id);
    const client = await connect(rig);
    await subscribe(client, session.id);
    client.send({ type: 'prompt', sessionId: session.id, text: 'slow' });
    await client.waitFor((message) => message.type === 'event' && message.event.kind === 'status' && message.event.status === 'running');

    const busy = await putAccount(rig, session.id, { accountId });

    expect(busy).toEqual({ status: 409, body: { error: 'session_busy' } });
    expect(findSessionById(rig.daemon.db, session.id)).toMatchObject({ accountId: null, status: 'running' });
    expect(accountEvents(rig, session.id)).toEqual([]);
    expect(await pidOf(session.id)).toBe(pid);

    client.send({ type: 'cancel', sessionId: session.id });
    await client.waitFor(isEvent('turn_end'));
    await client.waitFor((message) => message.type === 'event' && message.event.kind === 'status' && message.event.status === 'idle');
    expect((await putAccount(rig, session.id, { accountId })).status).toBe(200);
  });

  it.each(['starting', 'running', 'awaiting_permission'] as const)('status %s → 409 session_busy', async (status) => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude');
    insertRow(rig, { id: 'ocupada', agent: 'claude', status });

    expect(await putAccount(rig, 'ocupada', { accountId })).toEqual({ status: 409, body: { error: 'session_busy' } });
    expect(findSessionById(rig.daemon.db, 'ocupada')?.accountId).toBeNull();
  });

  it('sessão parada: só grava (com o evento); o próximo prompt retoma já na conta nova', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude', 'Trabalho');
    const session = await newSession(rig, 'claude');
    const oldPid = await pidOf(session.id);
    expect((await http(rig, 'DELETE', `/api/sessions/${session.id}`)).status).toBe(204);
    expect(await waitUntilDead(oldPid)).toBe(true);

    const reply = await putAccount(rig, session.id, { accountId });

    expect(reply.status).toBe(200);
    expect(SessionSchema.parse(reply.body)).toMatchObject({ accountId, status: 'stopped' });
    expect(accountEvents(rig, session.id)).toEqual([{ accountId, label: 'Trabalho' }]);
    // Nenhum processo subiu: o env gravado ainda é o do agente antigo.
    expect(await pidOf(session.id)).toBe(oldPid);
    expect((await recordedEnv(session.id)).CLAUDE_CONFIG_DIR).toBe(principalClaude);

    const client = await connect(rig);
    await subscribe(client, session.id);
    expect(await ask(client, session.id, '/env CLAUDE_CONFIG_DIR')).toBe(
      `CLAUDE_CONFIG_DIR=${profileHome(rig, 'claude', accountId)}`,
    );
    expect(await methodsOf(session.id)).toContain('session/load');
  });

  it('sessão com erro também só grava a conta', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude');
    insertRow(rig, { id: 'quebrada', agent: 'claude', status: 'error' });

    const reply = await putAccount(rig, 'quebrada', { accountId });

    expect(reply.status).toBe(200);
    expect(SessionSchema.parse(reply.body)).toMatchObject({ accountId, status: 'error' });
  });

  it('conta desconhecida → 400 invalid_request; agente sem contas extras → 400 accounts_unsupported (default é no-op)', async () => {
    const rig = await boot();
    const claude = await newSession(rig, 'claude');
    const omp = await newSession(rig, 'omp');

    expect(await putAccount(rig, claude.id, { accountId: 'fantasma' })).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(await putAccount(rig, omp.id, { accountId: 'qualquer' })).toEqual({
      status: 400,
      body: { error: 'accounts_unsupported' },
    });
    expect((await putAccount(rig, omp.id, { accountId: 'default' })).status).toBe(200);
    expect(findSessionById(rig.daemon.db, claude.id)?.accountId).toBeNull();
  });

  it('sessão inexistente → 404; corpo inválido → 400', async () => {
    const rig = await boot();
    const session = await newSession(rig, 'claude');

    expect(await putAccount(rig, 'nao-existe', { accountId: 'default' })).toEqual({ status: 404, body: { error: 'not_found' } });
    for (const payload of [{}, { accountId: '' }, { accountId: 3 }]) {
      expect(await putAccount(rig, session.id, payload)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
  });

  it('agente que não sabe retomar: 409 not_resumable e a sessão fica como estava (o processo segue vivo)', async () => {
    const rig = await boot({ claudeEnv: { FAKE_AGENT_RESUME: 'none' } });
    const accountId = await addAccount(rig, 'claude');
    const session = await newSession(rig, 'claude');
    const pid = await pidOf(session.id);

    const reply = await putAccount(rig, session.id, { accountId });

    expect(reply).toEqual({ status: 409, body: { error: 'not_resumable' } });
    expect(findSessionById(rig.daemon.db, session.id)).toMatchObject({ accountId: null, status: 'idle' });
    expect(accountEvents(rig, session.id)).toEqual([]);
    expect(isAlive(pid)).toBe(true);
    expect(await pidOf(session.id)).toBe(pid);
  });
});

/** Processos de uso de claude: os `.env.json` que não são de sessão, indexados pelo nome da pasta de trabalho. */
async function probeProcesses(sessionIds: readonly string[]): Promise<Map<string, { key: string; env: RecordedEnv }>> {
  const found = new Map<string, { key: string; env: RecordedEnv }>();
  for (const name of await readdir(pidDir)) {
    if (!name.endsWith('.env.json')) continue;
    const key = name.slice(0, -'.env.json'.length);
    if (sessionIds.includes(key)) continue;
    const recorded = await recordedEnv(key);
    found.set(basename(recorded.cwd), { key, env: recorded });
  }
  return found;
}

async function usageCached(rig: Rig, sessionId: string): Promise<boolean> {
  const reply = await http(rig, 'POST', `/api/sessions/${sessionId}/usage`);
  expect(reply.status).toBe(200);
  return UsageResponseSchema.parse(reply.body).cached === true;
}

describe('leitura de uso por conta', () => {
  it('cada conta tem o próprio processo, pasta de trabalho, arquivo de sessão e cache; a principal mantém o layout de sempre', async () => {
    const rig = await boot({ usageCacheMs: 60_000 });
    const accountA = await addAccount(rig, 'claude', 'A');
    const accountB = await addAccount(rig, 'claude', 'B');
    const principal = await newSession(rig, 'claude');
    const sessionA = await newSession(rig, 'claude', accountA);
    const sessionB = await newSession(rig, 'claude', accountB);
    const ids = [principal.id, sessionA.id, sessionB.id];

    for (const session of [principal, sessionA, sessionB]) expect(await usageCached(rig, session.id)).toBe(false);
    for (const session of [principal, sessionA, sessionB]) expect(await usageCached(rig, session.id)).toBe(true);

    const probes = await probeProcesses(ids);
    expect([...probes.keys()].sort()).toEqual(['claude', `claude@${accountA}`, `claude@${accountB}`].sort());
    expect(probes.get('claude')?.env.CLAUDE_CONFIG_DIR).toBe(principalClaude);
    expect(probes.get(`claude@${accountA}`)?.env.CLAUDE_CONFIG_DIR).toBe(profileHome(rig, 'claude', accountA));
    expect(probes.get(`claude@${accountB}`)?.env.CLAUDE_CONFIG_DIR).toBe(profileHome(rig, 'claude', accountB));
    const pids = await Promise.all([...probes.values()].map((probe) => pidOf(probe.key)));
    expect(new Set(pids).size).toBe(3);
    expect(pids.every((pid) => isAlive(pid))).toBe(true);

    const root = join(rig.daemon.home, 'usage-probe');
    expect((await readdir(root)).sort()).toEqual(
      [
        'claude',
        'claude.session',
        `claude@${accountA}`,
        `claude@${accountA}.session`,
        `claude@${accountB}`,
        `claude@${accountB}.session`,
      ].sort(),
    );
  });

  it('o processo de uso da principal sem contas extras fica em <NANACHI_HOME>/usage-probe/<agente>, com <agente>.session', async () => {
    const rig = await boot();
    const session = await newSession(rig, 'claude');

    expect(await usageCached(rig, session.id)).toBe(false);

    const probes = await probeProcesses([session.id]);
    expect([...probes.keys()]).toEqual(['claude']);
    expect(probes.get('claude')?.env.cwd).toBe(join(rig.daemon.home, 'usage-probe', 'claude'));
    expect((await readdir(join(rig.daemon.home, 'usage-probe'))).sort()).toEqual(['claude', 'claude.session']);
  });

  it('trocar a conta da sessão muda o processo de uso que ela consulta', async () => {
    const rig = await boot({ usageCacheMs: 60_000 });
    const accountId = await addAccount(rig, 'claude');
    const session = await newSession(rig, 'claude');
    expect(await usageCached(rig, session.id)).toBe(false);

    expect((await putAccount(rig, session.id, { accountId })).status).toBe(200);

    // Outra conta, outro slot: a leitura não vem do cache da principal.
    expect(await usageCached(rig, session.id)).toBe(false);
    const probes = await probeProcesses([session.id]);
    expect([...probes.keys()].sort()).toEqual(['claude', `claude@${accountId}`].sort());
  });
});

async function listResets(rig: Rig, sessionId: string): Promise<ResetsResponse> {
  const reply = await http(rig, 'GET', `/api/sessions/${sessionId}/usage/resets`);
  expect(reply.status).toBe(200);
  return ResetsResponseSchema.parse(reply.body);
}

async function redeem(rig: Rig, sessionId: string, target: string, headers?: { authorization: string }): Promise<Reply> {
  const res = await rig.daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/usage/resets`,
    headers: headers ?? rig.headers,
    payload: { target },
  });
  return { status: res.statusCode, body: res.json<unknown>() };
}

/** Linhas de FAKE_CODEX_ENV_FILE: o CODEX_HOME de cada app-server que subiu, na ordem. */
async function codexHomesSeen(): Promise<Array<string | null>> {
  const text = await readFile(codexEnvFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      const home = typeof parsed === 'object' && parsed !== null && 'CODEX_HOME' in parsed ? parsed.CODEX_HOME : null;
      return typeof home === 'string' ? home : null;
    });
}

describe('resets por conta', () => {
  it('codex: o app-server roda com o CODEX_HOME da conta da sessão, e o cache da listagem é por conta', async () => {
    const rig = await boot({ usageCacheMs: 60_000 });
    const accountA = await addAccount(rig, 'codex', 'A');
    const accountB = await addAccount(rig, 'codex', 'B');
    const principal = await newSession(rig, 'codex');
    const sessionA = await newSession(rig, 'codex', accountA);
    const sessionB = await newSession(rig, 'codex', accountB);

    for (const session of [principal, sessionA, sessionB]) {
      expect((await listResets(rig, session.id)).cached).toBeUndefined();
    }
    for (const session of [principal, sessionA, sessionB]) {
      expect((await listResets(rig, session.id)).cached).toBe(true);
    }

    expect(await codexHomesSeen()).toEqual([
      principalCodex,
      profileHome(rig, 'codex', accountA),
      profileHome(rig, 'codex', accountB),
    ]);
    // A pasta do perfil compartilha as sessões com a principal.
    expect((await lstat(join(profileHome(rig, 'codex', accountA), 'sessions'))).isSymbolicLink()).toBe(true);
  });

  it('codex: um resgate esquece só o cache de resets e de uso da conta dele', async () => {
    const rig = await boot({ usageCacheMs: 60_000 });
    const accountA = await addAccount(rig, 'codex', 'A');
    const accountB = await addAccount(rig, 'codex', 'B');
    const sessionA = await newSession(rig, 'codex', accountA);
    const sessionB = await newSession(rig, 'codex', accountB);
    for (const session of [sessionA, sessionB]) {
      await listResets(rig, session.id);
      expect(await usageCached(rig, session.id)).toBe(false);
      expect(await usageCached(rig, session.id)).toBe(true);
    }

    const outcome = await redeem(rig, sessionA.id, 'next');
    expect(outcome.status).toBe(200);
    expect(ResetRedeemResponseSchema.parse(outcome.body).outcome).toBe('nothing_to_reset');

    expect((await listResets(rig, sessionA.id)).cached).toBeUndefined();
    expect(await usageCached(rig, sessionA.id)).toBe(false);
    expect((await listResets(rig, sessionB.id)).cached).toBe(true);
    expect(await usageCached(rig, sessionB.id)).toBe(true);
  });

  it('codex: um resgate por vez por conta (a mesma conta → 409), contas diferentes não se bloqueiam', async () => {
    const rig = await boot({ codexEnv: { FAKE_CODEX_CONSUME: 'hang' }, usageTimeoutMs: 1_500 });
    const accountA = await addAccount(rig, 'codex', 'A');
    const accountB = await addAccount(rig, 'codex', 'B');
    const sessionA = await newSession(rig, 'codex', accountA);
    const sessionA2 = await newSession(rig, 'codex', accountA);
    const sessionB = await newSession(rig, 'codex', accountB);
    const auth = rig.headers;

    const sameAccount = await Promise.all([redeem(rig, sessionA.id, 'next', auth), redeem(rig, sessionA2.id, 'next', auth)]);
    expect(sameAccount.map((reply) => reply.status).sort()).toEqual([409, 504]);
    const conflict = sameAccount.find((reply) => reply.status === 409);
    expect(conflict?.body).toEqual({ error: 'reset_in_progress' });

    const differentAccounts = await Promise.all([redeem(rig, sessionA.id, 'next', auth), redeem(rig, sessionB.id, 'next', auth)]);
    expect(differentAccounts.map((reply) => reply.status)).toEqual([504, 504]);
  });

  it('omp não tem contas no Nanachi: duas sessões com account_id diferentes dividem o mesmo processo, cache e trava (2º resgate → 409)', async () => {
    const rig = await boot({ usageCacheMs: 60_000, ompEnv: { FAKE_AGENT_RESET_DELAY_MS: '800' } });
    insertRow(rig, { id: 'omp-a', agent: 'omp', status: 'stopped', accountId: 'conta-a' });
    insertRow(rig, { id: 'omp-b', agent: 'omp', status: 'stopped', accountId: 'conta-b' });
    const auth = rig.headers;

    const [first, second] = await Promise.all([
      redeem(rig, 'omp-a', 'anthropic/1', auth),
      redeem(rig, 'omp-b', 'anthropic/1', auth),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const conflict = first.status === 409 ? first : second;
    expect(conflict.body).toEqual({ error: 'reset_in_progress' });

    // Um único processo de uso, na pasta do agente, sem pasta de conta no env.
    const probes = await probeProcesses([]);
    expect([...probes.keys()]).toEqual(['omp']);
    expect(probes.get('omp')?.env.CLAUDE_CONFIG_DIR).toBe(process.env.CLAUDE_CONFIG_DIR);
    expect(probes.get('omp')?.env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect((await readdir(join(rig.daemon.home, 'usage-probe'))).filter((name) => name.includes('@'))).toEqual([]);

    // A listagem é a mesma para as duas sessões (mesma chave de cache: o agente).
    expect((await listResets(rig, 'omp-a')).cached).toBeUndefined();
    expect((await listResets(rig, 'omp-b')).cached).toBe(true);
  });
});

describe('remover a conta: estado só em memória', () => {
  /** Espera o pid do agente da sessão mudar (um agente novo subiu). */
  async function waitForNewPid(sessionId: string, oldPid: number): Promise<number> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const pid = await pidOf(sessionId).catch(() => oldPid);
      if (pid !== oldPid) return pid;
      if (Date.now() > deadline) throw new Error('o agente retomado não subiu');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('sessão parada no banco mas retomando (Retomar): remover a conta é 409 e a pasta fica inteira; depois de parar, remove', async () => {
    const rig = await boot({ claudeEnv: { FAKE_AGENT_LOAD_DELAY_MS: '2500' } });
    const accountId = await addAccount(rig, 'claude');
    const session = await newSession(rig, 'claude', accountId);
    const oldPid = await pidOf(session.id);
    expect((await http(rig, 'DELETE', `/api/sessions/${session.id}`)).status).toBe(204);
    expect(await waitUntilDead(oldPid)).toBe(true);

    const resuming = http(rig, 'POST', `/api/sessions/${session.id}/resume`);
    const newPid = await waitForNewPid(session.id, oldPid);

    // The row still says "stopped": a manual Retomar does not mark "starting". Only the memory knows.
    expect(findSessionById(rig.daemon.db, session.id)?.status).toBe('stopped');
    expect(await http(rig, 'DELETE', `/api/agents/claude/accounts/${accountId}`)).toEqual({
      status: 409,
      body: { error: 'account_in_use' },
    });
    expect((await lstat(join(profileHome(rig, 'claude', accountId), 'projects'))).isSymbolicLink()).toBe(true);

    const resumed = await resuming;
    expect(resumed.status).toBe(200);
    expect(SessionSchema.parse(resumed.body)).toMatchObject({ status: 'idle', accountId });
    expect(isAlive(newPid)).toBe(true);
    expect(existsSync(profileHome(rig, 'claude', accountId))).toBe(true);

    expect((await http(rig, 'DELETE', `/api/sessions/${session.id}`)).status).toBe(204);
    expect(await waitUntilDead(newPid)).toBe(true);
    expect((await http(rig, 'DELETE', `/api/agents/claude/accounts/${accountId}`)).status).toBe(204);
    expect(existsSync(profileHome(rig, 'claude', accountId))).toBe(false);
  });

  it('um prompt que retoma a sessão enquanto a conta é removida não recria a pasta: ou 409, ou a retomada falha limpa', async () => {
    const rig = await boot({ claudeEnv: { FAKE_AGENT_LOAD_DELAY_MS: '300' } });
    const accountId = await addAccount(rig, 'claude');
    const session = await newSession(rig, 'claude', accountId);
    expect((await http(rig, 'DELETE', `/api/sessions/${session.id}`)).status).toBe(204);
    const client = await connect(rig);
    await subscribe(client, session.id);

    client.send({ type: 'prompt', sessionId: session.id, text: 'oi' });
    const removal = await http(rig, 'DELETE', `/api/agents/claude/accounts/${accountId}`);
    // Whatever the order: the delete answered, and nothing half-deleted is left.
    expect([204, 409]).toContain(removal.status);
    await client.waitFor((message) => message.type === 'error' || isEvent('turn_end')(message));

    if (removal.status === 204) {
      expect(existsSync(profileHome(rig, 'claude', accountId))).toBe(false);
      expect(findSessionById(rig.daemon.db, session.id)?.accountId).toBeNull();
    } else {
      expect((await lstat(join(profileHome(rig, 'claude', accountId), 'projects'))).isSymbolicLink()).toBe(true);
    }
  });
});

describe('troca de conta ao mesmo tempo que um prompt', () => {
  it('PUT /account e um prompt juntos, em três voltas: o estado final é consistente em qualquer ordem', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude', 'Trabalho');
    const session = await newSession(rig, 'claude');
    const client = await connect(rig);
    await subscribe(client, session.id);

    for (const [round, target] of [accountId, 'default', accountId].entries()) {
      const expectedHome = target === 'default' ? principalClaude : profileHome(rig, 'claude', accountId);
      const put = putAccount(rig, session.id, { accountId: target });
      // The prompt lands while the switch is stopping the agent, or just before it starts: a different gap each round.
      await new Promise((resolve) => setTimeout(resolve, round * 4));
      client.send({ type: 'prompt', sessionId: session.id, text: 'oi' });
      const reply = await put;
      await client.waitFor((message) => message.type === 'error' || isEvent('turn_end')(message));

      // Either the switch happened, or it was refused because the agent was already working: never a 5xx.
      expect([200, 409], JSON.stringify(reply.body)).toContain(reply.status);
      const row = findSessionById(rig.daemon.db, session.id);
      if (reply.status === 409) {
        // The agent was working on the prompt: the account did not change. Now that it is idle the switch goes through.
        expect(row?.accountId).toBe(target === 'default' ? accountId : null);
        expect((await putAccount(rig, session.id, { accountId: target })).status).toBe(200);
      }
      expect(findSessionById(rig.daemon.db, session.id)).toMatchObject({
        accountId: target === 'default' ? null : accountId,
        status: 'idle',
      });
      // One agent process for the session, and it runs with the folder of the account the row says.
      const pid = await pidOf(session.id);
      expect(isAlive(pid)).toBe(true);
      expect(await ask(client, session.id, '/env CLAUDE_CONFIG_DIR')).toBe(`CLAUDE_CONFIG_DIR=${expectedHome}`);
    }
    expect(accountEvents(rig, session.id).map((event) => event.accountId)).toEqual([accountId, null, accountId]);
  });
});

describe('remover a conta', () => {
  it('mata o processo de uso dela, apaga a pasta e o arquivo de sessão de uso e devolve as sessões dela à principal', async () => {
    const rig = await boot({ usageCacheMs: 60_000 });
    const accountId = await addAccount(rig, 'claude');
    const principal = await newSession(rig, 'claude');
    const session = await newSession(rig, 'claude', accountId);
    expect(await usageCached(rig, principal.id)).toBe(false);
    expect(await usageCached(rig, session.id)).toBe(false);
    const probes = await probeProcesses([principal.id, session.id]);
    const accountProbe = probes.get(`claude@${accountId}`);
    const principalProbe = probes.get('claude');
    if (accountProbe === undefined || principalProbe === undefined) throw new Error('processos de uso não subiram');
    const accountPid = await pidOf(accountProbe.key);
    const principalPid = await pidOf(principalProbe.key);

    // Com a sessão viva na conta, a remoção é recusada.
    expect(await http(rig, 'DELETE', `/api/agents/claude/accounts/${accountId}`)).toEqual({
      status: 409,
      body: { error: 'account_in_use' },
    });
    expect(isAlive(accountPid)).toBe(true);

    expect((await http(rig, 'DELETE', `/api/sessions/${session.id}`)).status).toBe(204);
    expect((await http(rig, 'DELETE', `/api/agents/claude/accounts/${accountId}`)).status).toBe(204);

    expect(await waitUntilDead(accountPid)).toBe(true);
    expect(isAlive(principalPid)).toBe(true);
    const root = join(rig.daemon.home, 'usage-probe');
    expect((await readdir(root)).sort()).toEqual(['claude', 'claude.session']);
    expect(existsSync(profileHome(rig, 'claude', accountId))).toBe(false);
    expect(findSessionById(rig.daemon.db, session.id)?.accountId).toBeNull();

    // A sessão agora é da principal: a leitura vem do slot da principal (que segue em cache).
    expect(await usageCached(rig, session.id)).toBe(true);
  });
});

describe('retomada do agente na conta da sessão', () => {
  /** Espera o status da sessão no banco. */
  async function waitForStatus(daemon: TestDaemon, sessionId: string, status: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const current = findSessionById(daemon.db, sessionId)?.status;
      if (current === status) return;
      if (Date.now() > deadline) throw new Error(`sessão ${sessionId} não chegou a ${status} (está ${String(current)})`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it('reload: a sessão volta na conta que tinha (e a principal na principal)', async () => {
    const a = await startDaemon(env.home, startOptions({}));
    extraDaemons.push(a);
    const workspaceId = await createWorkspace(a, workspace);
    const rigA: Rig = { daemon: a, workspaceId, headers: await authHeader(a), notices: [] };
    const accountId = await addAccount(rigA, 'claude');
    const onAccount = await newSession(rigA, 'claude', accountId);
    const onPrincipal = await newSession(rigA, 'claude');
    const saved = saveIdleSessionsForReload(a.db, env.home, Date.now());
    expect([...saved].sort()).toEqual([onAccount.id, onPrincipal.id].sort());
    await stopDaemon(a);
    extraDaemons.splice(extraDaemons.indexOf(a), 1);

    const ids = takeResumeAfterReload(env.home, Date.now());
    const b = await startDaemon(env.home, { ...startOptions({}), resumeAfterReload: ids });
    extraDaemons.push(b);
    stopInterruptedSessions(b.db, Date.now());
    await listen(b);
    await waitForStatus(b, onAccount.id, 'idle');
    await waitForStatus(b, onPrincipal.id, 'idle');

    expect(findSessionById(b.db, onAccount.id)?.accountId).toBe(accountId);
    expect((await recordedEnv(onAccount.id)).CLAUDE_CONFIG_DIR).toBe(join(env.home, 'accounts', 'claude', accountId));
    expect(findSessionById(b.db, onPrincipal.id)?.accountId).toBeNull();
    expect((await recordedEnv(onPrincipal.id)).CLAUDE_CONFIG_DIR).toBe(principalClaude);
    expect(await methodsOf(onAccount.id)).toContain('session/load');
  });

  it('conta que não existe mais na linha da sessão: retoma na principal, sem erro', async () => {
    const rig = await boot();
    const accountId = await addAccount(rig, 'claude');
    const session = await newSession(rig, 'claude', accountId);
    expect((await http(rig, 'DELETE', `/api/sessions/${session.id}`)).status).toBe(204);
    // Estado que o serviço de contas não deixa acontecer (ele zera o account_id), mas o banco pode ter.
    rig.daemon.db.prepare<[string, string]>('UPDATE sessions SET account_id = ? WHERE id = ?').run('fantasma', session.id);

    const resumed = await http(rig, 'POST', `/api/sessions/${session.id}/resume`);

    expect(resumed.status).toBe(200);
    expect(SessionSchema.parse(resumed.body).status).toBe('idle');
    expect((await recordedEnv(session.id)).CLAUDE_CONFIG_DIR).toBe(principalClaude);
  });
});
