import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { AgentConfig } from '@nanachi/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodexAppServerError,
  codexAppServerCommand,
  codexAppServerEnv,
  JsonRpcLines,
  withCodexAppServer,
  type CodexAppServerOptions,
  type RpcChild,
} from '../src/codex-app-server.js';
import { waitUntilDead } from './agent-support.js';
import { removeTempDir } from './temp.js';

/*
 * Cliente JSON-RPC curto do app-server do codex (codex-app-server.ts). Os testes usam o fixture
 * test/fixtures/fake-codex-app-server.mjs pelo CODEX_PATH, nunca o codex de verdade: consume gasta crédito real.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex-app-server.mjs', import.meta.url));

let base: string;

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-codex-')));
});

afterEach(async () => {
  await removeTempDir(base);
});

describe('codexAppServerCommand', () => {
  it('CODEX_PATH executável: roda esse arquivo com app-server', () => {
    expect(codexAppServerCommand('C:\\bin\\codex.exe', () => 'nao-usado')).toEqual({
      file: 'C:\\bin\\codex.exe',
      args: ['app-server'],
    });
  });

  it('CODEX_PATH em .js/.mjs: roda pelo node (o fixture de teste e scripts assim)', () => {
    expect(codexAppServerCommand('/tmp/fake.mjs', () => 'nao-usado')).toEqual({
      file: process.execPath,
      args: ['/tmp/fake.mjs', 'app-server'],
    });
  });

  it('sem CODEX_PATH: node com o codex.js empacotado pelo codex-acp', () => {
    expect(codexAppServerCommand(undefined, () => '/pacote/codex.js')).toEqual({
      file: process.execPath,
      args: ['/pacote/codex.js', 'app-server'],
    });
  });

  it('o codex.js empacotado resolve a partir do codex-acp instalado', () => {
    // Sem o argumento de teste: resolve de verdade pelo pacote @agentclientprotocol/codex-acp.
    const { args } = codexAppServerCommand(undefined);
    const script = args[0] ?? '';
    expect(script.replace(/\\/g, '/').endsWith('@openai/codex/bin/codex.js')).toBe(true);
    expect(existsSync(script)).toBe(true);
    expect(args.at(-1)).toBe('app-server');
  });
});

describe('codexAppServerEnv', () => {
  it('une process.env, env do agente e extra; sem variáveis NANACHI_*', () => {
    const env = codexAppServerEnv(
      { CUSTOM_FLAG: 'agent', NANACHI_URL: 'http://x' },
      { EXTRA_HOME: 'account' },
      { PATH: '/bin', NANACHI_AGENT_TOKEN: 'secret', KEEP: 'yes' },
    );
    expect(env.CUSTOM_FLAG).toBe('agent');
    expect(env.EXTRA_HOME).toBe('account');
    expect(env.KEEP).toBe('yes');
    expect(Object.keys(env).some((key) => key.startsWith('NANACHI_'))).toBe(false);
  });

  it('o extra vence o env do agente', () => {
    const env = codexAppServerEnv({ CODEX_HOME: 'a' }, { CODEX_HOME: 'b' }, {});
    expect(env.CODEX_HOME).toBe('b');
  });

  it.skipIf(process.platform !== 'win32')('Windows: Codex_Home e CODEX_HOME são a mesma variável; vale a do extra', () => {
    const env = codexAppServerEnv({ codex_home: 'agent' }, { CODEX_HOME: 'account' }, { Codex_Home: 'daemon' });
    const homes = Object.entries(env).filter(([key]) => key.toUpperCase() === 'CODEX_HOME');
    expect(homes).toEqual([['CODEX_HOME', 'account']]);
  });

  it('um extra undefined tira a variável (a principal ignora uma pasta herdada de conta extra)', () => {
    const env = codexAppServerEnv({ CODEX_HOME: 'agent' }, { CODEX_HOME: undefined }, { CODEX_HOME: 'daemon', KEEP: 'yes' });
    expect(Object.keys(env)).not.toContain('CODEX_HOME');
    expect(env.KEEP).toBe('yes');
  });

  it.skipIf(process.platform !== 'win32')('Windows: NANACHI_* sai em qualquer caixa', () => {
    const env = codexAppServerEnv({ Nanachi_Url: 'http://x' }, {}, { NANACHI_AGENT_TOKEN: 'secret', KEEP: 'yes' });
    expect(Object.keys(env).filter((key) => key.toUpperCase().startsWith('NANACHI_'))).toEqual([]);
  });
});

/** Opções do cliente apontando para o fixture, com o env dado no agente. */
function optionsFor(env: Record<string, string>, overrides: Partial<CodexAppServerOptions> = {}): CodexAppServerOptions {
  const agent: AgentConfig = { label: 'Codex', command: 'codex-acp', args: [], env: { CODEX_PATH: FIXTURE, ...env }, kind: 'acp' };
  return { agent, cwd: base, timeoutMs: 5_000, appVersion: '9.9.9', ...overrides };
}

/** Linhas JSON que o fixture recebeu (cada uma é uma mensagem do cliente). */
async function received(record: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(record, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A child process that is only its pipes and events: the test decides the order they happen in. */
function scriptedChild(): { child: RpcChild; stdout: PassThrough; events: EventEmitter } {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const child: RpcChild = Object.assign(events, { stdin: new PassThrough(), stdout });
  return { child, stdout, events };
}

describe('JsonRpcLines', () => {
  it('exit alone does not fail a request: the answer still in the pipe is read after it (rejects on close)', async () => {
    const { child, stdout, events } = scriptedChild();
    const rpc = new JsonRpcLines(child);
    const answer = rpc.request('account/read', {});

    // The process is gone and the exit was reported, and only then does its last line come out of the pipe.
    events.emit('exit', 0, null);
    stdout.write('{"id":1,"result":{"account":null}}\n');
    stdout.end();
    events.emit('close', 0, null);

    await expect(answer).resolves.toEqual({ account: null });
  });

  it('close with the request still unanswered fails it', async () => {
    const { child, stdout, events } = scriptedChild();
    const rpc = new JsonRpcLines(child);
    const answer = rpc.request('account/read', {});

    events.emit('exit', 9, null);
    stdout.end();
    events.emit('close', 9, null);

    await expect(answer).rejects.toMatchObject({ kind: 'failed' });
    await expect(rpc.request('account/read', {})).rejects.toMatchObject({ kind: 'failed' });
  });
});

/** Waits until the fixture has recorded a message with that method. */
async function waitForRecorded(record: string, method: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await received(record)).some((message) => message.method === method)) {
    if (Date.now() > deadline) throw new Error(`the fixture never received ${method}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('withCodexAppServer', () => {
  it('handshake sem jsonrpc, depois account/read e account/rateLimits/read', async () => {
    const record = join(base, 'rec.jsonl');
    const result = await withCodexAppServer(optionsFor({ FAKE_CODEX_RECORD: record }), async (client) => {
      const account = await client.accountRead();
      const limits = await client.rateLimitsRead();
      return { account, limits };
    });
    expect(result.account).toEqual({ email: 'fake@example.com' });
    expect(result.limits.rateLimitResetCredits?.availableCount).toBe(2);

    const messages = await received(record);
    expect(messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
    ]);
    expect(messages.some((message) => 'jsonrpc' in message)).toBe(false);
    expect(messages[0]?.params).toEqual({
      clientInfo: { name: 'nanachi', title: 'Nanachi Remote', version: '9.9.9' },
      capabilities: null,
    });
  });

  it('consume manda idempotencyKey e creditId; sem creditId o campo não vai', async () => {
    const record = join(base, 'rec.jsonl');
    const outcomes = await withCodexAppServer(optionsFor({ FAKE_CODEX_RECORD: record }), async (client) => [
      await client.consumeResetCredit({ idempotencyKey: 'key-1', creditId: 'credit-2' }),
      await client.consumeResetCredit({ idempotencyKey: 'key-2' }),
    ]);
    expect(outcomes).toEqual(['reset', 'nothingToReset']);

    const consumes = (await received(record)).filter((message) => message.method === 'account/rateLimitResetCredit/consume');
    expect(consumes.map((message) => message.params)).toEqual([
      { idempotencyKey: 'key-1', creditId: 'credit-2' },
      { idempotencyKey: 'key-2' },
    ]);
  });

  it('erro JSON-RPC vira rpc, sem o texto do erro na exceção exposta ao HTTP', async () => {
    const error = await withCodexAppServer(optionsFor({ FAKE_CODEX_CREDITS: 'error' }), (client) =>
      client.rateLimitsRead(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexAppServerError);
    expect(error).toMatchObject({ kind: 'rpc' });
  });

  it('processo que sai antes de responder vira failed', async () => {
    const error = await withCodexAppServer(optionsFor({ FAKE_CODEX_EXIT_ON: 'account/read' }), (client) =>
      client.accountRead(),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'failed' });
  });

  it('executável que não existe vira failed', async () => {
    const error = await withCodexAppServer(
      optionsFor({ CODEX_PATH: join(base, 'nao-existe.exe') }),
      (client) => client.accountRead(),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'failed' });
  });

  it('teto de 30 s da operação: timeout, e o processo morre', async () => {
    const pidFile = join(base, 'pid');
    const record = join(base, 'rec.jsonl');
    // Node can take a while to start under load: the ceiling must be longer than that, or it would cut the start-up and
    // not the hang. The record below proves the fixture answered the handshake and received the read that never ends.
    const error = await withCodexAppServer(
      optionsFor(
        { FAKE_CODEX_CREDITS: 'hang', FAKE_CODEX_PID_FILE: pidFile, FAKE_CODEX_RECORD: record },
        { timeoutMs: 2_500 },
      ),
      (client) => client.rateLimitsRead(),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect((await received(record)).map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);

    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('um processo que responde e sai em seguida entrega a resposta', async () => {
    const account = await withCodexAppServer(optionsFor({ FAKE_CODEX_EXIT_AFTER: 'account/read' }), (client) =>
      client.accountRead(),
    );
    expect(account).toEqual({ email: 'fake@example.com' });
  });

  it('a signal that aborts the operation kills the process and fails it (daemon shutdown)', async () => {
    const pidFile = join(base, 'pid');
    const record = join(base, 'rec.jsonl');
    const controller = new AbortController();
    const operation = withCodexAppServer(
      optionsFor(
        { FAKE_CODEX_CREDITS: 'hang', FAKE_CODEX_PID_FILE: pidFile, FAKE_CODEX_RECORD: record },
        { signal: controller.signal, timeoutMs: 30_000 },
      ),
      (client) => client.rateLimitsRead(),
    ).catch((caught: unknown) => caught);
    await waitForRecorded(record, 'account/rateLimits/read');

    controller.abort();
    const error = await operation;
    expect(error).toBeInstanceOf(CodexAppServerError);
    expect(error).toMatchObject({ kind: 'failed' });

    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('a signal already aborted fails the operation without starting the process', async () => {
    const pidFile = join(base, 'pid');
    const error = await withCodexAppServer(
      optionsFor({ FAKE_CODEX_PID_FILE: pidFile }, { signal: AbortSignal.abort() }),
      (client) => client.accountRead(),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'failed' });
    expect(existsSync(pidFile)).toBe(false);
  });

  it('o processo morre ao fim da operação, com sucesso', async () => {
    const pidFile = join(base, 'pid');
    await withCodexAppServer(optionsFor({ FAKE_CODEX_PID_FILE: pidFile }), (client) => client.accountRead());
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('resposta que não tem o formato esperado vira failed', async () => {
    const error = await withCodexAppServer(optionsFor({ FAKE_CODEX_CONSUME: 'weird' }), (client) =>
      client.consumeResetCredit({ idempotencyKey: 'k' }),
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'failed' });
  });
});
