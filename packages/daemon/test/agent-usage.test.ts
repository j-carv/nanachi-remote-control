import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EventsResponseSchema,
  SessionSchema,
  UsageResponseSchema,
  WorkspaceSchema,
  type AgentConfig,
  type ServerMessage,
  type Session,
  type UsageResponse,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  crashingAgent,
  fakeAgent,
  isEvent,
  listen,
  pairToken,
  promptsReceived,
  waitUntilDead,
  WsTestClient,
} from './agent-support.js';
import { setupDaemonTests, type StartOptions, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Uso do agente (POST /api/sessions/:id/usage). O comando local (`/usage` ou `/status`) roda num processo ACP
 * próprio de uso, por tipo de agente: independe da sessão do usuário (funciona com ela rodando, parada ou com
 * erro). O processo fica vivo um tempo ocioso e é reaproveitado; a resposta fica em cache por um prazo curto.
 * Nada disso vira evento nem broadcast. O fake agent responde /usage com texto e ANSI (ver fixtures/fake-agent.ts).
 *
 * Cada processo de uso grava <pidDir>/<chave>.pid com uma chave própria (o id aleatório do processo), então
 * "processos de uso" são os .pid que não são da sessão do teste.
 */

const PTY_FIXTURE = fileURLToPath(new URL('./fixtures/pty-echo.mjs', import.meta.url));

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-usage-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

const env = setupDaemonTests();

interface Started {
  daemon: TestDaemon;
  session: Session;
  workspaceId: string;
  client: WsTestClient;
}

interface StartArgs {
  /** Id do agente configurado: omp e claude mapeiam para /usage, codex para /status; fake não mapeia. */
  agent?: string;
  agentEnv?: Record<string, string>;
  usageTimeoutMs?: number;
  /** Padrão nos testes: 0 (sem cache), para que cada chamada consulte o agente. */
  usageCacheMs?: number;
  usageIdleMs?: number;
}

function optionsOf(agent: AgentConfig, args: StartArgs): StartOptions {
  return {
    config: { allowedRoots: [workspace], agents: { [args.agent ?? 'omp']: agent } },
    usageTimeoutMs: args.usageTimeoutMs,
    usageCacheMs: args.usageCacheMs ?? 0,
    usageIdleMs: args.usageIdleMs,
  };
}

/** Daemon com um agente falso, uma sessão ociosa dele e um cliente WS inscrito nela. */
async function start(args: StartArgs = {}): Promise<Started> {
  const agent = fakeAgent({ FAKE_AGENT_PID_DIR: pidDir, ...args.agentEnv });
  const daemon = await env.start(optionsOf(agent, args));
  const agentName = args.agent ?? 'omp';
  const workspaceId = await createWorkspaceId(daemon);
  const session = await createSession(daemon, { workspaceId, agent: agentName });
  const url = await listen(daemon);
  const client = await WsTestClient.connect(url, await pairToken(daemon));
  client.send({ type: 'subscribe', sessionId: session.id, afterSeq: 0 });
  await client.waitFor(isEvent('status'));
  await client.sync();
  return { daemon, session, workspaceId, client };
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

/** Status de uma sessão lido pela API (a listagem de sessões da pasta). */
async function sessionStatus(daemon: TestDaemon, sessionId: string, workspaceId: string): Promise<string | undefined> {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/workspaces/${workspaceId}/sessions`,
    headers: await authHeader(daemon),
  });
  const body = res.json<{ sessions: unknown[] }>();
  return body.sessions
    .map((item) => SessionSchema.parse(item))
    .find((item) => item.id === sessionId)?.status;
}

/** Números de seq dos eventos gravados na sessão (a timeline inteira). */
async function eventSeqs(daemon: TestDaemon, sessionId: string): Promise<number[]> {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/events?after=0&limit=500`,
    headers: await authHeader(daemon),
  });
  return EventsResponseSchema.parse(res.json<unknown>()).events.map((event) => event.seq);
}

/** POST /usage que espera 200 e devolve o corpo validado. */
async function usageOf(daemon: TestDaemon, sessionId: string): Promise<UsageResponse> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/usage`,
    headers: await authHeader(daemon),
  });
  expect(res.statusCode).toBe(200);
  return UsageResponseSchema.parse(res.json<unknown>());
}

/** POST /usage que espera um erro: devolve o corpo cru para comparar. */
async function errorOf(daemon: TestDaemon, sessionId: string, expectedStatus: number): Promise<unknown> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/usage`,
    headers: await authHeader(daemon),
  });
  expect(res.statusCode).toBe(expectedStatus);
  return res.json<unknown>();
}

function isStatus(status: string): (message: ServerMessage) => boolean {
  return (message) => message.type === 'event' && message.event.kind === 'status' && message.event.status === status;
}

/** Chaves dos processos de uso que já subiram (todo .pid que não é da sessão `sessionId`). */
async function probeKeys(sessionId: string): Promise<string[]> {
  const files = await readdir(pidDir).catch(() => [] as string[]);
  return files
    .filter((name) => name.endsWith('.pid') && name !== `${sessionId}.pid`)
    .map((name) => name.slice(0, -'.pid'.length))
    .sort();
}

/** Espera até um processo de uso receber um prompt e devolve a chave dele. */
async function probeWithPrompt(sessionId: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    for (const key of await probeKeys(sessionId)) {
      if ((await promptsReceived(pidDir, key)).length > 0) return key;
    }
    if (Date.now() > deadline) throw new Error('nenhum processo de uso recebeu prompt');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** O único processo de uso novo desde `before` (a chave que não existia antes). */
async function newProbeKey(sessionId: string, before: readonly string[]): Promise<string> {
  const added = (await probeKeys(sessionId)).filter((key) => !before.includes(key));
  if (added.length !== 1) throw new Error(`esperava 1 processo de uso novo, vieram ${added.length}`);
  return added[0] ?? '';
}

async function pidOf(key: string): Promise<number> {
  return Number(await readFile(join(pidDir, `${key}.pid`), 'utf8'));
}

/** Métodos ACP que o daemon mandou ao processo `key` (gravados pelo fake em <key>.methods.jsonl). */
async function methodsSent(key: string): Promise<string[]> {
  const text = await readFile(join(pidDir, `${key}.methods.jsonl`), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string);
}

/** Cwd com que o processo `key` subiu (gravado pelo fake em <key>.env.json). */
async function cwdOf(key: string): Promise<string> {
  const data = JSON.parse(await readFile(join(pidDir, `${key}.env.json`), 'utf8')) as { cwd: string };
  return data.cwd;
}

describe('POST /api/sessions/:id/usage', () => {
  it('devolve o texto que o agente respondeu, com ANSI, além de agent e fetchedAt', async () => {
    const { daemon, session } = await start();
    const before = Date.now();
    const body = await usageOf(daemon, session.id);

    expect(body.agent).toBe('omp');
    expect(body.text).toContain('62%');
    expect(body.text).toContain('\u001b[');
    expect(body.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(body.cached).toBeUndefined();
  });

  it('omp manda /usage como único bloco de texto, num processo próprio de uso', async () => {
    const { daemon, session } = await start();
    await usageOf(daemon, session.id);

    const [key] = await probeKeys(session.id);
    expect(key).toBeDefined();
    expect(await promptsReceived(pidDir, key ?? '')).toEqual([[{ type: 'text', text: '/usage' }]]);
    expect(await promptsReceived(pidDir, session.id)).toEqual([]);
  });

  it('codex manda /status', async () => {
    const { daemon, session } = await start({ agent: 'codex' });
    const body = await usageOf(daemon, session.id);

    expect(body.agent).toBe('codex');
    const [key] = await probeKeys(session.id);
    expect(await promptsReceived(pidDir, key ?? '')).toEqual([[{ type: 'text', text: '/status' }]]);
  });

  it('o processo de uso sobe na pasta própria <home>/usage-probe/<agente>', async () => {
    const { daemon, session } = await start();
    await usageOf(daemon, session.id);

    const [key] = await probeKeys(session.id);
    expect(realpathSync.native(await cwdOf(key ?? ''))).toBe(
      realpathSync.native(join(env.home, 'usage-probe', 'omp')),
    );
  });

  it('funciona com a sessão rodando: o turno do usuário segue e nada muda nele', async () => {
    const { daemon, session, client, workspaceId } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: 'slow' });
    await client.waitFor(isStatus('running'));
    // O turno do usuário grava os próprios eventos; o que importa é que o uso não grava nenhum.
    await client.waitFor((message) => JSON.stringify(message).includes('Trabalhando'));
    const seqsBefore = await eventSeqs(daemon, session.id);

    const body = await usageOf(daemon, session.id);

    expect(body.text).toContain('62%');
    expect(await eventSeqs(daemon, session.id)).toEqual(seqsBefore);
    expect(await sessionStatus(daemon, session.id, workspaceId)).toBe('running');
    client.send({ type: 'cancel', sessionId: session.id });
    await client.waitFor(isStatus('idle'));
  });

  it('não grava evento, não manda broadcast, não cria sessão e não muda o status', async () => {
    const { daemon, session, workspaceId, client } = await start();
    const seqsBefore = await eventSeqs(daemon, session.id);
    const messagesBefore = client.messages.length;

    await usageOf(daemon, session.id);
    await client.sync();

    expect(await eventSeqs(daemon, session.id)).toEqual(seqsBefore);
    // Nada chegou ao cliente WS além do pong do sync: nem `event`, nem `session`, nem `commands`.
    const sent = client.messages.slice(messagesBefore).filter((message) => message.type !== 'pong');
    expect(sent).toEqual([]);
    expect(await sessionStatus(daemon, session.id, workspaceId)).toBe('idle');
    const list = await daemon.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/sessions`,
      headers: await authHeader(daemon),
    });
    expect(list.json<{ sessions: unknown[] }>().sessions).toHaveLength(1);
  });

  it('sessão parada responde 200 com o uso e continua parada', async () => {
    const { daemon, session, workspaceId } = await start();
    await daemon.app.inject({ method: 'DELETE', url: `/api/sessions/${session.id}`, headers: await authHeader(daemon) });

    const body = await usageOf(daemon, session.id);

    expect(body.text).toContain('62%');
    expect(await sessionStatus(daemon, session.id, workspaceId)).toBe('stopped');
  });

  it('sessão com erro (o agente morreu) responde 200 com o uso', async () => {
    const { daemon, session, client } = await start();
    client.send({ type: 'prompt', sessionId: session.id, text: 'die' });
    await client.waitFor(isStatus('error'));

    const body = await usageOf(daemon, session.id);
    expect(body.text).toContain('62%');
  });

  it('o probe é reaproveitado dentro da janela de ociosidade: uma só inicialização, dois comandos', async () => {
    const { daemon, session } = await start({ usageIdleMs: 60_000 });
    await usageOf(daemon, session.id);
    await usageOf(daemon, session.id);

    const keys = await probeKeys(session.id);
    expect(keys).toHaveLength(1);
    expect(await promptsReceived(pidDir, keys[0] ?? '')).toHaveLength(2);
    expect((await methodsSent(keys[0] ?? '')).filter((method) => method === 'initialize')).toHaveLength(1);
  });

  it('chamadas simultâneas dividem um único probe e um único comando', async () => {
    const { daemon, session } = await start();
    const headers = await authHeader(daemon);
    const responses = await Promise.all(
      [1, 2, 3].map(() => daemon.app.inject({ method: 'POST', url: `/api/sessions/${session.id}/usage`, headers })),
    );

    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      expect(UsageResponseSchema.parse(res.json<unknown>()).text).toContain('62%');
    }
    const keys = await probeKeys(session.id);
    expect(keys).toHaveLength(1);
    expect(await promptsReceived(pidDir, keys[0] ?? '')).toHaveLength(1);
  });

  it('dentro do prazo do cache devolve a mesma leitura com cached: true, sem consultar o agente', async () => {
    const { daemon, session } = await start({ usageCacheMs: 60_000 });
    const first = await usageOf(daemon, session.id);
    const second = await usageOf(daemon, session.id);

    expect(first.cached).toBeUndefined();
    expect(second).toEqual({ ...first, cached: true });
    const [key] = await probeKeys(session.id);
    expect(await promptsReceived(pidDir, key ?? '')).toHaveLength(1);
  });

  it('depois do prazo do cache, a leitura é nova', async () => {
    const { daemon, session } = await start({ usageCacheMs: 150 });
    const first = await usageOf(daemon, session.id);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await usageOf(daemon, session.id);

    expect(second.cached).toBeUndefined();
    expect(second.fetchedAt).toBeGreaterThan(first.fetchedAt);
    const [key] = await probeKeys(session.id);
    expect(await promptsReceived(pidDir, key ?? '')).toHaveLength(2);
  });

  it('depois da janela de ociosidade o probe morre; o próximo sobe e carrega a sessão de uso salva', async () => {
    const { daemon, session } = await start({ usageIdleMs: 50 });
    await usageOf(daemon, session.id);
    const [first] = await probeKeys(session.id);
    expect(await waitUntilDead(await pidOf(first ?? ''))).toBe(true);

    await usageOf(daemon, session.id);
    const second = await newProbeKey(session.id, [first ?? '']);
    const methods = await methodsSent(second);
    expect(methods).toContain('session/load');
    expect(methods).not.toContain('session/new');
  });

  it('no timeout manda session/cancel, mata o probe, responde 504 e a sessão do usuário segue', async () => {
    const { daemon, session, workspaceId } = await start({
      agentEnv: { FAKE_AGENT_USAGE: 'hang' },
      usageTimeoutMs: 2_000,
    });
    const pending = daemon.app.inject({
      method: 'POST',
      url: `/api/sessions/${session.id}/usage`,
      headers: await authHeader(daemon),
    });
    // O timeout só cancela um comando já enviado: espera o prompt chegar ao processo de uso.
    const key = await probeWithPrompt(session.id);

    const res = await pending;
    expect(res.statusCode).toBe(504);
    expect(res.json<unknown>()).toEqual({ error: 'agent_timeout' });
    expect(await methodsSent(key)).toContain('session/cancel');
    expect(await waitUntilDead(await pidOf(key))).toBe(true);
    expect(await sessionStatus(daemon, session.id, workspaceId)).toBe('idle');
  });

  it('o agente de uso que morre antes de responder dá 502 agent_failed', async () => {
    const { daemon, session } = await start();
    // Daemon à parte com um agente que sai ao subir: o probe morre antes do initialize.
    const broken = await env.start(optionsOf(crashingAgent(), { agent: 'omp' }));
    const brokenWorkspace = await createWorkspaceId(broken);
    const brokenSession = await createSession(broken, { workspaceId: brokenWorkspace, agent: 'omp' });

    expect(await errorOf(broken, brokenSession.id, 502)).toEqual({ error: 'agent_failed' });
    // O daemon principal, com a sessão ativa, não foi afetado.
    expect((await usageOf(daemon, session.id)).text).toContain('62%');
  });

  it('fechar o daemon mata o probe de uso (o mesmo caminho do reload)', async () => {
    const { daemon, session } = await start();
    await usageOf(daemon, session.id);
    const [key] = await probeKeys(session.id);
    const pid = await pidOf(key ?? '');

    await daemon.app.close();
    daemon.db.close();

    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('terminal (pty) responde 400 usage_unsupported', async () => {
    const agents: Record<string, AgentConfig> = {
      term: { label: 'Terminal', command: process.execPath, args: [PTY_FIXTURE], env: {}, kind: 'pty' },
    };
    const daemon = await env.start({ config: { allowedRoots: [workspace], agents } });
    const workspaceId = await createWorkspaceId(daemon);
    const terminal = await createSession(daemon, { workspaceId, agent: 'term' });

    expect(await errorOf(daemon, terminal.id, 400)).toEqual({ error: 'usage_unsupported' });
  });

  it('agente sem comando de uso mapeado responde 400 usage_unsupported', async () => {
    const { daemon, session } = await start({ agent: 'fake' });
    expect(await errorOf(daemon, session.id, 400)).toEqual({ error: 'usage_unsupported' });
  });

  it('sessão inexistente responde 404', async () => {
    const { daemon } = await start();
    expect(await errorOf(daemon, 'nao-existe', 404)).toEqual({ error: 'not_found' });
  });
});
