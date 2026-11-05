import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import type { AgentConfig } from '@nanachi/shared';
import { mergeEnv } from './agent-env.js';
import { agentBinDirs, withPathPrepended } from './agent-path.js';
import { killAgent, spawnAgent, type AgentChild } from './agent-process.js';
import type { CodexResetCredits } from './usage-resets.js';

/*
 * Cliente curto do app-server do codex (docs/PLAN.md, "rate-limit resets in the usage drawer"). Uma conexão por
 * operação: sobe o codex empacotado, faz initialize + initialized, manda UMA chamada e mata o processo. Protocolo
 * de linhas JSON-RPC sem o campo `jsonrpc`, como o app-server espera. Só os métodos de reset e de conta existem
 * aqui: nunca thread nem turn.
 */

/** Métodos que o cliente manda. `initialized` é notificação (sem id), enviada só no handshake. */
type CodexRequestMethod =
  | 'initialize'
  | 'account/read'
  | 'account/rateLimits/read'
  | 'account/rateLimitResetCredit/consume';

/**
 * Por que a operação falhou. `timeout` vira 504 e `failed` 502 na rota; `rpc` é um erro JSON-RPC do servidor (o
 * texto dele vai para o log do daemon, nunca para o corpo HTTP).
 */
export class CodexAppServerError extends Error {
  readonly kind: 'failed' | 'timeout' | 'rpc';

  constructor(kind: 'failed' | 'timeout' | 'rpc', message: string) {
    super(message);
    this.name = 'CodexAppServerError';
    this.kind = kind;
  }
}

export interface CodexAccount {
  /** E-mail da conta ChatGPT; null para conta de API ou sem login. */
  email: string | null;
}

export interface CodexRateLimits {
  rateLimitResetCredits: CodexResetCredits | null;
}

/** `idempotencyKey` vem de quem chama (um UUID por POST); `creditId` ausente = o backend escolhe o próximo. */
export interface CodexConsumeParams {
  idempotencyKey: string;
  creditId?: string;
}

export type CodexConsumeOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

/** As três chamadas que o daemon faz. Cada uma responde o tipo validado, ou lança CodexAppServerError. */
export interface CodexAppServerClient {
  accountRead(): Promise<CodexAccount>;
  rateLimitsRead(): Promise<CodexRateLimits>;
  consumeResetCredit(params: CodexConsumeParams): Promise<CodexConsumeOutcome>;
}

export interface CodexAppServerOptions {
  /** Config do agente `codex` (env, e CODEX_PATH). Os outros campos do agente não são usados aqui. */
  agent: AgentConfig;
  /** Pasta de trabalho do processo. */
  cwd: string;
  /** Teto da operação inteira (handshake e a chamada). Passou disso, o processo morre e a operação dá timeout. */
  timeoutMs: number;
  /** Versão do daemon, mandada em `clientInfo`. */
  appVersion: string;
  /**
   * Env a mais, por cima do env do agente: o ponto de extensão para a home de uma conta (contas ainda não existem).
   * Sem ele, o env é o do agente.
   */
  extraEnv?: NodeJS.ProcessEnv | undefined;
  /** Linhas do stderr do processo (log de debug). */
  onDiagnostic?: ((line: string) => void) | undefined;
  /** Quando aborta (o daemon está encerrando ou recarregando), o processo morre e a operação falha. Já abortado: nem sobe. */
  signal?: AbortSignal | undefined;
}

const ABORTED_MESSAGE = 'app-server cancelado: o daemon está encerrando';
const CLIENT_INFO_NAME = 'nanachi';
const CLIENT_INFO_TITLE = 'Nanachi Remote';
const CONSUME_OUTCOMES: readonly CodexConsumeOutcome[] = ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'];

/** Comando que sobe o app-server: CODEX_PATH (executável, ou .js/.mjs/.cjs pelo node) ou o codex empacotado. */
export function codexAppServerCommand(
  codexPath: string | undefined,
  resolveBundled: () => string = bundledCodexScript,
): { file: string; args: string[] } {
  if (codexPath !== undefined && codexPath.trim() !== '') {
    if (/\.[cm]?js$/i.test(codexPath)) return { file: process.execPath, args: [codexPath, 'app-server'] };
    return { file: codexPath, args: ['app-server'] };
  }
  return { file: process.execPath, args: [resolveBundled(), 'app-server'] };
}

/**
 * `codex.js` do @openai/codex que o @agentclientprotocol/codex-acp traz, resolvido a partir do pacote do codex-acp
 * (como o próprio codex-acp faz quando CODEX_PATH não está definido).
 */
export function bundledCodexScript(): string {
  const requireFromHere = createRequire(import.meta.url);
  const codexAcpManifest = requireFromHere.resolve('@agentclientprotocol/codex-acp/package.json');
  return createRequire(codexAcpManifest).resolve('@openai/codex/bin/codex.js');
}

/**
 * Env do processo: process.env, env do agente e `extra`, com o PATH dos agentes na frente. Sem NANACHI_*: o token e a
 * URL de um agente de sessão não passam para o app-server. A mesclagem ignora a caixa no Windows (`Codex_Home` e
 * `CODEX_HOME` são a mesma variável, a do `extra` vale) e um valor `undefined` no `extra` tira a variável.
 */
export function codexAppServerEnv(
  agentEnv: Record<string, string>,
  extraEnv: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = mergeEnv([base, agentEnv, extraEnv]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!key.toUpperCase().startsWith('NANACHI_')) env[key] = value;
  }
  return withPathPrepended(env, agentBinDirs());
}

/** Roda `use` com um app-server novo, já no handshake, e mata o processo ao terminar (ou ao estourar o teto). */
export async function withCodexAppServer<T>(
  options: CodexAppServerOptions,
  use: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const { signal } = options;
  if (signal?.aborted === true) throw new CodexAppServerError('failed', ABORTED_MESSAGE);
  const env = codexAppServerEnv(options.agent.env, options.extraEnv);
  const command = codexAppServerCommand(env.CODEX_PATH);
  let child: AgentChild;
  try {
    child = spawnAgent(
      { file: command.file, args: command.args, shell: false },
      { cwd: options.cwd, env, onDiagnostic: options.onDiagnostic ?? (() => undefined) },
    );
  } catch (error) {
    throw new CodexAppServerError('failed', `app-server não subiu: ${messageOf(error)}`);
  }

  const rpc = new JsonRpcLines(child);
  const work = (async (): Promise<T> => {
    await rpc.request('initialize', {
      clientInfo: { name: CLIENT_INFO_NAME, title: CLIENT_INFO_TITLE, version: options.appVersion },
      capabilities: null,
    });
    rpc.notify('initialized');
    return use(clientOf(rpc));
  })();
  // Um erro que chega depois do timeout (o processo morto derruba as pendências) não pode virar rejeição solta.
  work.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CodexAppServerError('timeout', `app-server não respondeu em ${options.timeoutMs} ms`));
    }, options.timeoutMs);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new CodexAppServerError('failed', ABORTED_MESSAGE));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, timeout, aborted]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    killAgent(child);
  }
}

/** Chamadas tipadas por cima do cliente de linhas: cada uma valida a resposta antes de devolver. */
function clientOf(rpc: JsonRpcLines): CodexAppServerClient {
  return {
    async accountRead() {
      return parseAccount(await rpc.request('account/read', {}));
    },
    async rateLimitsRead() {
      return parseRateLimits(await rpc.request('account/rateLimits/read', {}));
    },
    async consumeResetCredit(params) {
      const body: Record<string, unknown> = { idempotencyKey: params.idempotencyKey };
      if (params.creditId !== undefined) body.creditId = params.creditId;
      return parseConsume(await rpc.request('account/rateLimitResetCredit/consume', body));
    },
  };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** O que o cliente de linhas usa do processo: os pipes e dois eventos. */
export interface RpcChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

/** Cliente de linhas JSON-RPC sobre o stdio do processo. Respostas casam pelo id; o resto é ignorado. */
export class JsonRpcLines {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedBy: CodexAppServerError | undefined;

  constructor(private readonly child: RpcChild) {
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.once('error', (error) => this.close(new CodexAppServerError('failed', `app-server falhou: ${error.message}`)));
    // `close`, not `exit`: it comes after stdout ended, so an answer still in the pipe is read before the requests fail.
    child.once('close', () => this.close(new CodexAppServerError('failed', 'app-server saiu antes de responder')));
  }

  request(method: CodexRequestMethod, params: Record<string, unknown>): Promise<unknown> {
    if (this.closedBy !== undefined) return Promise.reject(this.closedBy);
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: 'initialized'): void {
    this.write({ method });
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed) || typeof parsed.id !== 'number') return;
    const waiting = this.pending.get(parsed.id);
    if (waiting === undefined) return;
    this.pending.delete(parsed.id);
    if (isRecord(parsed.error)) {
      const detail = typeof parsed.error.message === 'string' ? parsed.error.message : 'erro desconhecido';
      waiting.reject(new CodexAppServerError('rpc', `erro JSON-RPC do app-server: ${detail}`));
      return;
    }
    waiting.resolve(parsed.result);
  }

  private close(error: CodexAppServerError): void {
    if (this.closedBy !== undefined) return;
    this.closedBy = error;
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function malformed(method: string): CodexAppServerError {
  return new CodexAppServerError('failed', `resposta de ${method} fora do formato esperado`);
}

/** `account/read`: `{ account: { type: "chatgpt", email, ... } | { type: "apiKey" } | null, ... }`. */
function parseAccount(value: unknown): CodexAccount {
  if (!isRecord(value)) throw malformed('account/read');
  const account = value.account;
  if (isRecord(account) && account.type === 'chatgpt' && typeof account.email === 'string') {
    return { email: account.email };
  }
  return { email: null };
}

/** `account/rateLimits/read`: só `rateLimitResetCredits` importa aqui. Ausente conta como null. */
function parseRateLimits(value: unknown): CodexRateLimits {
  if (!isRecord(value)) throw malformed('account/rateLimits/read');
  const resets = value.rateLimitResetCredits;
  if (resets === undefined || resets === null) return { rateLimitResetCredits: null };
  if (!isRecord(resets) || typeof resets.availableCount !== 'number') throw malformed('account/rateLimits/read');
  const list = resets.credits;
  if (list === undefined || list === null) {
    return { rateLimitResetCredits: { availableCount: resets.availableCount, credits: null } };
  }
  if (!Array.isArray(list)) throw malformed('account/rateLimits/read');
  const credits = list.map((credit: unknown) => {
    if (!isRecord(credit) || typeof credit.id !== 'string' || typeof credit.status !== 'string') {
      throw malformed('account/rateLimits/read');
    }
    const expiresAt = typeof credit.expiresAt === 'number' ? credit.expiresAt : null;
    return { id: credit.id, status: credit.status, expiresAt };
  });
  return { rateLimitResetCredits: { availableCount: resets.availableCount, credits } };
}

/** `account/rateLimitResetCredit/consume`: `{ outcome }` com um dos quatro valores conhecidos. */
function parseConsume(value: unknown): CodexConsumeOutcome {
  if (isRecord(value)) {
    const outcome = CONSUME_OUTCOMES.find((known) => known === value.outcome);
    if (outcome !== undefined) return outcome;
  }
  throw malformed('account/rateLimitResetCredit/consume');
}
