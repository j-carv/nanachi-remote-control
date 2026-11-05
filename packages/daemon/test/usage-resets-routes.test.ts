import { mkdtemp, mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EventsResponseSchema,
  ResetRedeemResponseSchema,
  ResetsResponseSchema,
  UsageResponseSchema,
  type AgentConfig,
  type ResetRedeemResponse,
  type ResetsResponse,
} from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeader,
  createSession,
  createWorkspace,
  fakeAgent,
  promptsReceived,
  waitUntilDead,
} from './agent-support.js';
import { setupDaemonTests, stopDaemon, type StartOptions, type TestDaemon } from './support.js';
import { removeTempDir } from './temp.js';

/*
 * Resets salvos (GET/POST /api/sessions/:id/usage/resets). omp responde pelo processo de uso com o texto de
 * `/usage reset` (fake agent); codex pelo app-server falso (test/fixtures/fake-codex-app-server.mjs, via CODEX_PATH).
 * Nunca o omp nem o codex de verdade: o resgate gasta crédito.
 */

const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));
const PTY_FIXTURE = fileURLToPath(new URL('./fixtures/pty-echo.mjs', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let base: string;
let workspace: string;
let pidDir: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-resets-')));
  workspace = join(base, 'projeto');
  pidDir = join(base, 'pids');
  await mkdir(workspace);
});

afterEach(async () => {
  await removeTempDir(base);
});

const env = setupDaemonTests();

interface StartArgs {
  /** Agente da sessão: omp, codex, claude (sem fonte de resets) ou agy (terminal). Padrão: omp. */
  agent?: string;
  /** Env do agente da sessão (omp ou codex): o fake agent e o app-server falso leem daqui. */
  agentEnv?: Record<string, string>;
  usageTimeoutMs?: number | undefined;
  /** Padrão nos testes: 0 (sem cache). */
  usageCacheMs?: number | undefined;
}

/** Daemon com uma sessão do agente pedido. omp e codex são fake agents; `agentEnv` vai para o da sessão. */
async function start(args: StartArgs = {}): Promise<{ daemon: TestDaemon; sessionId: string }> {
  const agentName = args.agent ?? 'omp';
  const agents: Record<string, AgentConfig> = {
    omp: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir, ...(agentName === 'omp' ? args.agentEnv : {}) }),
    codex: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir, ...(agentName === 'codex' ? args.agentEnv : {}) }),
    claude: fakeAgent({ FAKE_AGENT_PID_DIR: pidDir }),
    agy: { label: 'Terminal', command: process.execPath, args: [PTY_FIXTURE], env: {}, kind: 'pty' },
  };
  const options: StartOptions = {
    config: { allowedRoots: [workspace], agents },
    usageTimeoutMs: args.usageTimeoutMs,
    usageCacheMs: args.usageCacheMs ?? 0,
  };
  const daemon = await env.start(options);
  const workspaceId = await createWorkspace(daemon, workspace);
  const session = await createSession(daemon, { workspaceId, agent: agentName });
  return { daemon, sessionId: session.id };
}

interface Reply {
  status: number;
  body: unknown;
}

async function get(daemon: TestDaemon, sessionId: string, headers?: { authorization: string }): Promise<Reply> {
  const res = await daemon.app.inject({
    method: 'GET',
    url: `/api/sessions/${sessionId}/usage/resets`,
    headers: headers ?? (await authHeader(daemon)),
  });
  return { status: res.statusCode, body: res.json<unknown>() };
}

/** POST do resgate. Os headers vêm de fora quando há chamadas concorrentes: pareia só uma vez (pareamento é por código). */
async function post(
  daemon: TestDaemon,
  sessionId: string,
  payload: Record<string, unknown>,
  headers?: { authorization: string },
): Promise<Reply> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/usage/resets`,
    headers: headers ?? (await authHeader(daemon)),
    payload,
  });
  return { status: res.statusCode, body: res.json<unknown>() };
}

async function listing(daemon: TestDaemon, sessionId: string): Promise<ResetsResponse> {
  const reply = await get(daemon, sessionId);
  expect(reply.status).toBe(200);
  return ResetsResponseSchema.parse(reply.body);
}

async function redeemed(daemon: TestDaemon, sessionId: string, target: string): Promise<ResetRedeemResponse> {
  const reply = await post(daemon, sessionId, { target });
  expect(reply.status).toBe(200);
  return ResetRedeemResponseSchema.parse(reply.body);
}

/** POST /usage (leitura de uso do agente) que espera 200 e devolve se veio do cache. */
async function usageCached(daemon: TestDaemon, sessionId: string): Promise<boolean> {
  const res = await daemon.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/usage`,
    headers: await authHeader(daemon),
  });
  expect(res.statusCode).toBe(200);
  return UsageResponseSchema.parse(res.json<unknown>()).cached === true;
}

/** Chaves dos processos de uso (todo .pid que não é da sessão). */
async function probeKeys(sessionId: string): Promise<string[]> {
  const files = await readdir(pidDir).catch(() => [] as string[]);
  return files
    .filter((name) => name.endsWith('.pid') && name !== `${sessionId}.pid`)
    .map((name) => name.slice(0, -'.pid'.length))
    .sort();
}

/** Textos de todos os prompts que os processos de uso receberam. */
async function probePrompts(sessionId: string): Promise<string[]> {
  const texts: string[] = [];
  for (const key of await probeKeys(sessionId)) {
    for (const blocks of await promptsReceived(pidDir, key)) {
      for (const block of blocks) {
        if (block.type === 'text') texts.push(block.text);
      }
    }
  }
  return texts;
}

/**
 * Espera um prompt novo chegar a um processo de uso (count maior que `before`). O timeout só corta um comando já
 * enviado: sem isso, um timeout curto dispara antes de o processo subir e a asserção do teste fica sem alvo.
 */
async function waitForNewPrompt(sessionId: string, before: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await probePrompts(sessionId)).length <= before) {
    if (Date.now() > deadline) throw new Error('nenhum prompt chegou ao processo de uso');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Espera o arquivo existir (o fixture grava o pid ao subir). */
async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`arquivo não apareceu: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Mensagens JSON que o app-server falso recebeu, em ordem (arquivo FAKE_CODEX_RECORD). */
async function codexMessages(record: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(record, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Métodos de consume recebidos, com a idempotencyKey de cada um (undefined se o campo faltar). */
function consumesOf(messages: Array<Record<string, unknown>>): Array<{ params: unknown; key: string | undefined }> {
  return messages
    .filter((message) => message.method === 'account/rateLimitResetCredit/consume')
    .map((message) => {
      const params = message.params;
      const key =
        typeof params === 'object' && params !== null && 'idempotencyKey' in params && typeof params.idempotencyKey === 'string'
          ? params.idempotencyKey
          : undefined;
      return { params, key };
    });
}

describe('resets do omp', () => {
  it('listagem: entradas do /usage reset, sem cache na primeira leitura', async () => {
    const { daemon, sessionId } = await start();
    const body = await listing(daemon, sessionId);

    expect(body.agent).toBe('omp');
    expect(body.message).toBeNull();
    expect(body.cached).toBeUndefined();
    expect(body.entries.map((entry) => entry.target)).toEqual(['anthropic/1', 'openai-codex/2']);
    expect(body.entries[0]).toEqual({
      target: 'anthropic/1',
      accountLabel: 'fake@example.com · Org',
      providerLabel: 'Anthropic',
      available: 2,
      usable: 1,
      expiresAt: 'in 3 days',
      note: null,
      active: true,
    });
    expect(await probePrompts(sessionId)).toEqual(['/usage reset']);
  });

  it('segunda listagem dentro do cache: cached true e nenhum turno novo', async () => {
    const { daemon, sessionId } = await start({ usageCacheMs: 60_000 });
    await listing(daemon, sessionId);
    const again = await listing(daemon, sessionId);

    expect(again.cached).toBe(true);
    expect(await probePrompts(sessionId)).toEqual(['/usage reset']);
  });

  it('resgate: 200 com o resultado do omp (ANSI removido) e o comando exato', async () => {
    const { daemon, sessionId } = await start();
    const result = await redeemed(daemon, sessionId, 'anthropic/1');

    expect(result).toEqual({
      outcome: 'reset',
      message: 'Reset applied for fake@example.com (Anthropic) — 5h session limit refreshed.',
    });
    expect(await probePrompts(sessionId)).toEqual(['/usage reset anthropic/1']);
  });

  it('cada resposta de falha vira o seu resultado; conta não encontrada vira failed', async () => {
    const { daemon, sessionId } = await start();

    expect((await redeemed(daemon, sessionId, 'anthropic/2')).outcome).toBe('already_redeemed');
    expect((await redeemed(daemon, sessionId, 'anthropic/3')).outcome).toBe('no_credit');
    expect((await redeemed(daemon, sessionId, 'anthropic/4')).outcome).toBe('nothing_to_reset');
    const unknown = await redeemed(daemon, sessionId, 'anthropic/9');
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toBe('Could not find the stored account anthropic/9');
  });

  it('alvo fora do formato: 400 invalid_request e nenhum comando é enviado', async () => {
    const { daemon, sessionId } = await start();
    const bad: Array<Record<string, unknown>> = [
      { target: 'openai/1' },
      { target: 'anthropic/abc' },
      { target: 'anthropic/1 --all' },
      { target: '' },
      {},
    ];
    for (const payload of bad) {
      expect(await post(daemon, sessionId, payload)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await probePrompts(sessionId)).toEqual([]);
  });

  it('um resgate por vez: o segundo concorrente recebe 409 reset_in_progress sem enviar nada', async () => {
    const { daemon, sessionId } = await start({ agentEnv: { FAKE_AGENT_RESET_DELAY_MS: '800' } });
    const auth = await authHeader(daemon);
    const [first, second] = await Promise.all([
      post(daemon, sessionId, { target: 'anthropic/1' }, auth),
      post(daemon, sessionId, { target: 'anthropic/1' }, auth),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const conflict = first.status === 409 ? first : second;
    expect(conflict.body).toEqual({ error: 'reset_in_progress' });
    expect(await probePrompts(sessionId)).toEqual(['/usage reset anthropic/1']);
  });

  it('a redeem that arrives while a usage read is in flight waits its turn and sends exactly one redeem prompt', async () => {
    const { daemon, sessionId } = await start({ agentEnv: { FAKE_AGENT_USAGE_DELAY_MS: '700' } });
    const auth = await authHeader(daemon);
    const done: string[] = [];

    const read = daemon.app
      .inject({ method: 'POST', url: `/api/sessions/${sessionId}/usage`, headers: auth })
      .then((res) => {
        done.push('read');
        return res;
      });
    await waitForNewPrompt(sessionId, 0);
    const redeem = post(daemon, sessionId, { target: 'anthropic/1' }, auth).then((reply) => {
      done.push('redeem');
      return reply;
    });

    expect((await read).statusCode).toBe(200);
    const reply = await redeem;
    expect(reply.status).toBe(200);
    expect(ResetRedeemResponseSchema.parse(reply.body).outcome).toBe('reset');

    // The read ended first, and the probe process saw the read and then one redeem: nothing sent twice.
    expect(done).toEqual(['read', 'redeem']);
    const prompts = await probePrompts(sessionId);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('reset');
    expect(prompts[1]).toBe('/usage reset anthropic/1');
  });

  it('a redeem that arrives while a listing is in flight waits its turn and sends exactly one redeem prompt', async () => {
    const { daemon, sessionId } = await start({
      usageCacheMs: 60_000,
      agentEnv: { FAKE_AGENT_USAGE_DELAY_MS: '700' },
    });
    const auth = await authHeader(daemon);
    const done: string[] = [];

    const listed = get(daemon, sessionId, auth).then((reply) => {
      done.push('listing');
      return reply;
    });
    await waitForNewPrompt(sessionId, 0);
    const redeem = post(daemon, sessionId, { target: 'anthropic/1' }, auth).then((reply) => {
      done.push('redeem');
      return reply;
    });

    expect((await listed).status).toBe(200);
    expect((await redeem).status).toBe(200);

    expect(done).toEqual(['listing', 'redeem']);
    expect(await probePrompts(sessionId)).toEqual(['/usage reset', '/usage reset anthropic/1']);
    // The listing began before the redeem ended: its answer is not kept, so the next read asks the agent again.
    expect((await listing(daemon, sessionId)).cached).toBeUndefined();
  });

  it('cache da listagem e da leitura de uso caem depois de um resgate, mesmo com erro', async () => {
    const { daemon, sessionId } = await start({ usageCacheMs: 60_000 });
    await listing(daemon, sessionId);
    expect((await listing(daemon, sessionId)).cached).toBe(true);
    expect(await usageCached(daemon, sessionId)).toBe(false);
    expect(await usageCached(daemon, sessionId)).toBe(true);

    await redeemed(daemon, sessionId, 'anthropic/9');

    expect((await listing(daemon, sessionId)).cached).toBeUndefined();
    expect(await usageCached(daemon, sessionId)).toBe(false);
  });

  it('listagem que termina depois de um resgate não entra no cache', async () => {
    const { daemon, sessionId } = await start({ usageCacheMs: 60_000, agentEnv: { FAKE_AGENT_RESET_DELAY_MS: '500' } });
    const auth = await authHeader(daemon);
    const [redeem, inFlight] = await Promise.all([
      post(daemon, sessionId, { target: 'anthropic/1' }, auth),
      get(daemon, sessionId, auth),
    ]);
    expect(redeem.status).toBe(200);
    expect(inFlight.status).toBe(200);

    expect((await listing(daemon, sessionId)).cached).toBeUndefined();
  });

  it('timeout: listagem e resgate dão 504 agent_timeout e o processo de uso morre', async () => {
    const { daemon, sessionId } = await start({ usageTimeoutMs: 2_000, agentEnv: { FAKE_AGENT_USAGE: 'hang' } });

    const listed = daemon.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/usage/resets`,
      headers: await authHeader(daemon),
    });
    await waitForNewPrompt(sessionId, 0);
    const timedOut = await listed;
    expect(timedOut.statusCode).toBe(504);
    expect(timedOut.json<unknown>()).toEqual({ error: 'agent_timeout' });

    const redeemPending = post(daemon, sessionId, { target: 'anthropic/1' });
    await waitForNewPrompt(sessionId, 1);
    expect(await redeemPending).toEqual({ status: 504, body: { error: 'agent_timeout' } });

    const keys = await probeKeys(sessionId);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      const pid = Number(await readFile(join(pidDir, `${key}.pid`), 'utf8'));
      expect(await waitUntilDead(pid)).toBe(true);
    }
  });

  it('a sessão não muda: nenhum evento novo gravado pela listagem ou pelo resgate', async () => {
    const { daemon, sessionId } = await start();
    const eventCount = async (): Promise<number> => {
      const res = await daemon.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/events?after=0&limit=500`,
        headers: await authHeader(daemon),
      });
      return EventsResponseSchema.parse(res.json<unknown>()).events.length;
    };
    const before = await eventCount();
    await listing(daemon, sessionId);
    await redeemed(daemon, sessionId, 'anthropic/1');
    expect(await eventCount()).toBe(before);
  });
});

describe('respostas de erro comuns', () => {
  it('agente sem fonte de resets (claude) responde 400 resets_unsupported em GET e POST', async () => {
    const { daemon, sessionId } = await start({ agent: 'claude' });
    expect(await get(daemon, sessionId)).toEqual({ status: 400, body: { error: 'resets_unsupported' } });
    expect(await post(daemon, sessionId, { target: 'anthropic/1' })).toEqual({
      status: 400,
      body: { error: 'resets_unsupported' },
    });
    expect(await probePrompts(sessionId)).toEqual([]);
  });

  it('terminal (pty) responde 400 resets_unsupported', async () => {
    const { daemon, sessionId } = await start({ agent: 'agy' });
    expect(await get(daemon, sessionId)).toEqual({ status: 400, body: { error: 'resets_unsupported' } });
  });

  it('sessão inexistente responde 404 not_found em GET e POST', async () => {
    const { daemon } = await start();
    expect(await get(daemon, 'nao-existe')).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await post(daemon, 'nao-existe', { target: 'anthropic/1' })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
  });
});

describe('resets do codex (app-server falso)', () => {
  interface CodexArgs {
    /** FAKE_CODEX_CREDITS do fixture: ids (padrão), null, none, error, hang. */
    credits?: string;
    /** FAKE_CODEX_CONSUME do fixture: ok (padrão), error, hang, weird. */
    consume?: string;
    usageTimeoutMs?: number | undefined;
    usageCacheMs?: number | undefined;
    /** CODEX_PATH trocado (ex.: arquivo que não existe). */
    codexPath?: string;
  }

  /** Daemon com a sessão codex; o app-server falso grava as mensagens em `record` e o pid em `pidFile`. */
  async function startCodex(args: CodexArgs = {}): Promise<{
    daemon: TestDaemon;
    sessionId: string;
    record: string;
    pidFile: string;
  }> {
    const record = join(base, 'codex.jsonl');
    const pidFile = join(base, 'codex.pid');
    const agentEnv: Record<string, string> = {
      CODEX_PATH: args.codexPath ?? CODEX_FIXTURE,
      FAKE_CODEX_RECORD: record,
      FAKE_CODEX_PID_FILE: pidFile,
    };
    if (args.credits !== undefined) agentEnv.FAKE_CODEX_CREDITS = args.credits;
    if (args.consume !== undefined) agentEnv.FAKE_CODEX_CONSUME = args.consume;
    const { daemon, sessionId } = await start({
      agent: 'codex',
      agentEnv,
      usageTimeoutMs: args.usageTimeoutMs,
      usageCacheMs: args.usageCacheMs,
    });
    return { daemon, sessionId, record, pidFile };
  }

  it('listagem: uma conta, o crédito que expira antes como alvo, data em ISO, e só métodos de conta/reset', async () => {
    const { daemon, sessionId, record } = await startCodex();
    const body = await listing(daemon, sessionId);

    expect(body.message).toBeNull();
    expect(body.entries).toEqual([
      {
        target: 'credit-2',
        accountLabel: 'fake@example.com',
        providerLabel: 'OpenAI Codex',
        available: 2,
        usable: 2,
        expiresAt: new Date(1_750_000_000 * 1000).toISOString(),
        note: null,
        active: true,
      },
    ]);
    const methods = (await codexMessages(record)).map((message) => message.method);
    expect(methods).toEqual(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
  });

  it('credits null: alvo next com a contagem como utilizáveis; rateLimitResetCredits null: sem entradas', async () => {
    const withoutList = await startCodex({ credits: 'null' });
    expect((await listing(withoutList.daemon, withoutList.sessionId)).entries).toEqual([
      {
        target: 'next',
        accountLabel: 'fake@example.com',
        providerLabel: 'OpenAI Codex',
        available: 2,
        usable: 2,
        expiresAt: null,
        note: null,
        active: true,
      },
    ]);

    const none = await startCodex({ credits: 'none' });
    const empty = await listing(none.daemon, none.sessionId);
    expect(empty.entries).toEqual([]);
    expect(empty.message).toBe('Nenhum reset salvo nesta conta');
  });

  it('cache: segunda listagem cached true, sem nova leitura da conta', async () => {
    const { daemon, sessionId, record } = await startCodex({ usageCacheMs: 60_000 });
    await listing(daemon, sessionId);
    expect((await listing(daemon, sessionId)).cached).toBe(true);

    const reads = (await codexMessages(record)).filter((message) => message.method === 'account/read');
    expect(reads).toHaveLength(1);
  });

  it('resgate: consume com creditId da listagem e idempotencyKey única por POST; sem id, next', async () => {
    const { daemon, sessionId, record } = await startCodex();
    await listing(daemon, sessionId);

    expect(await redeemed(daemon, sessionId, 'credit-2')).toEqual({
      outcome: 'reset',
      message: 'Reset aplicado no Codex.',
    });
    expect(await redeemed(daemon, sessionId, 'next')).toEqual({
      outcome: 'nothing_to_reset',
      message: 'Nada para resetar agora: os limites não estão restringidos. Nenhum crédito foi gasto.',
    });

    const consumes = consumesOf(await codexMessages(record));
    expect(consumes).toHaveLength(2);
    expect(consumes[0]?.params).toEqual({ idempotencyKey: consumes[0]?.key, creditId: 'credit-2' });
    expect(consumes[1]?.params).toEqual({ idempotencyKey: consumes[1]?.key });
    expect(consumes[0]?.key).toMatch(UUID);
    expect(consumes[1]?.key).toMatch(UUID);
    expect(consumes[0]?.key).not.toBe(consumes[1]?.key);
  });

  it('codex outcomes: credit-1 is no_credit, and alreadyRedeemed from the app-server is already_redeemed', async () => {
    const { daemon, sessionId } = await startCodex();
    await listing(daemon, sessionId);
    expect((await redeemed(daemon, sessionId, 'credit-1')).outcome).toBe('no_credit');

    const again = await startCodex({ consume: 'already' });
    await listing(again.daemon, again.sessionId);
    expect(await redeemed(again.daemon, again.sessionId, 'credit-2')).toEqual({
      outcome: 'already_redeemed',
      message: 'Esse reset já foi usado.',
    });
  });

  it('a credit the app-server lists but that is not available (credit-3, redeemed) is no target: 400, nothing sent', async () => {
    const { daemon, sessionId, record } = await startCodex();
    await listing(daemon, sessionId);

    expect(await post(daemon, sessionId, { target: 'credit-3' })).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(consumesOf(await codexMessages(record))).toEqual([]);
  });

  it('listing never sends consume to the app-server, however many times it is read', async () => {
    const { daemon, sessionId, record } = await startCodex();
    await listing(daemon, sessionId);
    await listing(daemon, sessionId);
    await post(daemon, sessionId, { target: 'credit-99' });
    await listing(daemon, sessionId);

    const messages = await codexMessages(record);
    expect(consumesOf(messages)).toEqual([]);
    expect(messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
    ]);
  });

  it('id que não veio da última listagem: 400 invalid_request, e nada chega ao app-server', async () => {
    const { daemon, sessionId, record } = await startCodex();
    expect(await post(daemon, sessionId, { target: 'credit-2' })).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    await listing(daemon, sessionId);
    expect(await post(daemon, sessionId, { target: 'credit-99' })).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(consumesOf(await codexMessages(record))).toEqual([]);
  });

  it('erro JSON-RPC na listagem: 502 agent_failed, sem o texto do servidor no corpo', async () => {
    const { daemon, sessionId } = await startCodex({ credits: 'error' });
    const reply = await get(daemon, sessionId);
    expect(reply).toEqual({ status: 502, body: { error: 'agent_failed' } });
    expect(JSON.stringify(reply.body)).not.toContain('fixture-only');
  });

  it('erro JSON-RPC no resgate: 200 failed com texto fixo; o cache cai', async () => {
    const { daemon, sessionId } = await startCodex({ consume: 'error', usageCacheMs: 60_000 });
    await listing(daemon, sessionId);
    expect((await listing(daemon, sessionId)).cached).toBe(true);

    const result = await redeemed(daemon, sessionId, 'credit-2');
    expect(result.outcome).toBe('failed');
    expect(result.message).toBe('Não foi possível concluir o reset no Codex. Veja o log do daemon.');
    expect(result.message).not.toContain('fixture-only');
    expect((await listing(daemon, sessionId)).cached).toBeUndefined();
  });

  it('app-server que não sobe (CODEX_PATH inexistente): 502 agent_failed', async () => {
    const { daemon, sessionId } = await startCodex({ codexPath: join(base, 'nao-existe.mjs') });
    expect(await get(daemon, sessionId)).toEqual({ status: 502, body: { error: 'agent_failed' } });
  });

  it('timeout na listagem: 504 agent_timeout e o app-server morre', async () => {
    const { daemon, sessionId, pidFile } = await startCodex({ credits: 'hang', usageTimeoutMs: 2_000 });
    expect(await get(daemon, sessionId)).toEqual({ status: 504, body: { error: 'agent_timeout' } });
    await waitForFile(pidFile);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('timeout no resgate: o primeiro dá 504 agent_timeout e o concorrente 409 reset_in_progress', async () => {
    // The listing before it must finish inside the same ceiling, and node can start slowly under load.
    const { daemon, sessionId } = await startCodex({ consume: 'hang', usageTimeoutMs: 2_500 });
    await listing(daemon, sessionId);

    const auth = await authHeader(daemon);
    const [first, second] = await Promise.all([
      post(daemon, sessionId, { target: 'credit-2' }, auth),
      post(daemon, sessionId, { target: 'credit-2' }, auth),
    ]);
    expect([first.status, second.status].sort()).toEqual([409, 504]);
    const timedOut = first.status === 504 ? first : second;
    const conflict = first.status === 409 ? first : second;
    expect(timedOut.body).toEqual({ error: 'agent_timeout' });
    expect(conflict.body).toEqual({ error: 'reset_in_progress' });
  });

  it('closing the daemon kills the app-server that is in flight', async () => {
    const { daemon, sessionId, pidFile } = await startCodex({ credits: 'hang', usageTimeoutMs: 60_000 });
    const inFlight = daemon.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/usage/resets`,
      headers: await authHeader(daemon),
    });
    await waitForFile(pidFile);
    const pid = Number(await readFile(pidFile, 'utf8'));

    await stopDaemon(daemon);

    expect(await waitUntilDead(pid)).toBe(true);
    expect((await inFlight).statusCode).toBe(502);
  });
});
