import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentAccount } from '@nanachi/shared';
import { findExecutable } from './agent-command.js';

/**
 * Conta logada em cada agente. Cada verificador lê só o que precisa para responder (status, e-mail, plano,
 * nomes de provedores) e NUNCA devolve, loga ou põe em erro um token, chave ou trecho de arquivo de credencial.
 * Os textos de `detail` e de erro são constantes deste arquivo, nunca saída de comando ou de arquivo.
 */

type AccountStatus = AgentAccount['status'];

export interface AccountCheck {
  status: AccountStatus;
  account: string | null;
  detail: string | null;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

/** Roda um executável sem shell. Resolve mesmo com código de saída diferente de zero; rejeita se não rodou. */
export type RunCommand = (file: string, args: readonly string[], options: RunOptions) => Promise<CommandResult>;

export interface ProbeContext {
  /** Pasta do usuário (`~`): onde ficam `.codex` e `.omp`. */
  home: string;
  /** Env com o PATH dos agentes (agent-path.ts). */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Caminho do executável no PATH, ou undefined. */
  resolve(command: string): string | undefined;
  run: RunCommand;
}

export type Verifier = (context: ProbeContext) => Promise<AccountCheck>;

/** Erro de verificação com texto controlado pelo código (vai direto para `detail`). */
class CheckFailure extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'CheckFailure';
  }
}

const LOGGED_OUT: AccountCheck = { status: 'logged_out', account: null, detail: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Texto não vazio ou null. Qualquer outro tipo (número, objeto) não entra no resultado. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Partes não vazias unidas por " · "; nada sobrando → null. */
function joinParts(parts: readonly unknown[]): string | null {
  const texts = parts.map(textOrNull).filter((part): part is string => part !== null);
  return texts.length > 0 ? texts.join(' · ') : null;
}

/** Objeto JSON ou undefined. O erro do JSON.parse NÃO é repassado: ele pode citar o texto que falhou. */
function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Payload de um JWT, sem verificar assinatura (só para ler e-mail e plano). */
function decodeJwtPayload(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined || parts[1].length === 0) return undefined;
  return parseJsonObject(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

async function runCli(context: ProbeContext, command: string, args: readonly string[]): Promise<CommandResult> {
  const file = context.resolve(command);
  if (file === undefined) throw new CheckFailure('Comando não encontrado no PATH');
  // Sem shell, um .cmd não roda no Node 22 (EINVAL). Não ligamos shell só para isto.
  if (/\.(cmd|bat)$/i.test(file)) throw new CheckFailure('Launcher .cmd: verificação sem shell não suportada');
  return context.run(file, args, { timeoutMs: context.timeoutMs, env: context.env });
}

async function verifyClaude(context: ProbeContext): Promise<AccountCheck> {
  const { stdout } = await runCli(context, 'claude', ['auth', 'status']);
  const data = parseJsonObject(stdout);
  if (data === undefined || typeof data.loggedIn !== 'boolean') throw new CheckFailure('Saída inesperada');
  if (!data.loggedIn) return LOGGED_OUT;
  return {
    status: 'logged_in',
    account: textOrNull(data.email),
    detail: joinParts([data.orgName, data.subscriptionType]),
  };
}

/** `auth.json` do Codex: só e-mail e plano do id_token. Arquivo ausente ou ilegível → undefined, sem detalhes. */
async function readCodexIdentity(home: string): Promise<{ email: string | null; plan: string | null } | undefined> {
  let text: string;
  try {
    text = await readFile(join(home, '.codex', 'auth.json'), 'utf8');
  } catch {
    return undefined;
  }
  const auth = parseJsonObject(text);
  const tokens = auth?.tokens;
  if (!isRecord(tokens)) return undefined;
  const claims = decodeJwtPayload(tokens.id_token);
  if (claims === undefined) return undefined;
  const openaiAuth = claims['https://api.openai.com/auth'];
  return {
    email: textOrNull(claims.email),
    plan: isRecord(openaiAuth) ? textOrNull(openaiAuth.chatgpt_plan_type) : null,
  };
}

async function verifyCodex(context: ProbeContext): Promise<AccountCheck> {
  const { stdout, stderr } = await runCli(context, 'codex', ['login', 'status']);
  // O codex escreve esta linha no stderr; o texto nunca vai para o resultado, só é classificado.
  const text = `${stdout}\n${stderr}`;
  if (/not logged in/i.test(text)) return LOGGED_OUT;
  if (/logged in using chatgpt/i.test(text)) {
    const identity = await readCodexIdentity(context.home);
    return {
      status: 'logged_in',
      account: identity?.email ?? null,
      detail: joinParts(['ChatGPT', identity?.plan]),
    };
  }
  if (/logged in using an api key/i.test(text)) {
    return { status: 'logged_in', account: null, detail: 'API key' };
  }
  throw new CheckFailure('Saída inesperada');
}

/** E-mail dentro do campo `data` (JSON) de uma credencial. Qualquer outra forma → null. */
function emailOfCredential(data: unknown): string | null {
  return typeof data === 'string' ? textOrNull(parseJsonObject(data)?.email) : null;
}

/**
 * Credenciais ativas do omp (`auth_credentials` em agent.db), abertas só para leitura. Conta = e-mail da
 * credencial mais recente que tiver um; detalhe = provedores ativos, do mais recente para o mais antigo.
 */
function readOmpCredentials(dbPath: string): AccountCheck {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_credentials'").get();
    if (table === undefined) throw new CheckFailure('Esquema desconhecido');

    const rows: unknown[] = db
      .prepare(
        'SELECT provider, data FROM auth_credentials WHERE disabled_cause IS NULL ORDER BY updated_at DESC, id DESC',
      )
      .all();
    if (rows.length === 0) return LOGGED_OUT;

    let account: string | null = null;
    const providers: string[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const provider = textOrNull(row.provider);
      if (provider !== null && !providers.includes(provider)) providers.push(provider);
      account ??= emailOfCredential(row.data);
    }
    return { status: 'logged_in', account, detail: joinParts(providers) };
  } finally {
    db.close();
  }
}

async function verifyOmp(context: ProbeContext): Promise<AccountCheck> {
  const dbPath = join(context.home, '.omp', 'agent', 'agent.db');
  if (!existsSync(dbPath)) return LOGGED_OUT;
  return readOmpCredentials(dbPath);
}

/**
 * O Antigravity guarda o login no cofre de credenciais do Windows (entrada `gemini:antigravity`). Não há comando
 * de status e ler o cofre exige tocar no segredo: sem verificação segura.
 */
function verifyAgy(): Promise<AccountCheck> {
  return Promise.reject(new CheckFailure('Login no cofre do Windows: sem verificação segura'));
}

/** Traduz falhas conhecidas em `unknown` com o texto controlado; qualquer outra vira "Falha ao verificar". */
function guarded(verify: Verifier): Verifier {
  return async (context) => {
    try {
      return await verify(context);
    } catch (error) {
      const detail = error instanceof CheckFailure ? error.detail : 'Falha ao verificar';
      return { status: 'unknown', account: null, detail };
    }
  };
}

/** Verificadores por id de agente do config (`claude`, `codex`, `omp`, `agy`). Já tratam as próprias falhas. */
export const ACCOUNT_VERIFIERS: Readonly<Record<string, Verifier>> = {
  claude: guarded(verifyClaude),
  codex: guarded(verifyCodex),
  omp: guarded(verifyOmp),
  agy: guarded(verifyAgy),
};

const NO_VERIFIER: AccountCheck = { status: 'unknown', account: null, detail: 'Sem verificação' };
const TIMED_OUT: AccountCheck = { status: 'unknown', account: null, detail: 'Tempo esgotado' };
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TTL_MS = 5 * 60_000;

/** Roda `file` sem shell, com `windowsHide`. Código de saída ≠ 0 ainda é resposta; timeout e falha de spawn rejeitam. */
export function execCommand(file: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { env: options.env, timeout: options.timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        if (error.killed !== true && typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr });
          return;
        }
        reject(new Error('falha ao executar o comando de verificação'));
      },
    );
  });
}

function withLimit(check: Promise<AccountCheck>, ms: number): Promise<AccountCheck> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<AccountCheck>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([check, limit]).finally(() => clearTimeout(timer));
}

export interface AgentAccountsOptions {
  /** `agents` do config: id → label. A lista devolvida segue esta ordem. */
  agents: Readonly<Record<string, { label: string }>>;
  /** Pasta do usuário (onde ficam `.codex` e `.omp`). Padrão: `homedir()`. Não é o NANACHI_HOME. */
  home?: string | undefined;
  /** Env com o PATH dos agentes (ver `withPathPrepended`). */
  env: NodeJS.ProcessEnv;
  /** Padrão: procura no PATH de `env` (com as regras do Windows). */
  resolve?: ((command: string) => string | undefined) | undefined;
  /** Padrão: `execCommand`. Testes injetam um falso. */
  run?: RunCommand | undefined;
  /** Padrão: `Date.now`. */
  now?: (() => number) | undefined;
  /** Teto por agente. Padrão: 15 s. */
  timeoutMs?: number | undefined;
  /** Validade do cache em memória. Padrão: 5 min. */
  ttlMs?: number | undefined;
}

export interface AgentAccountsService {
  /** `refresh` ignora o cache. Chamadas simultâneas compartilham a mesma verificação. */
  list(options?: { refresh?: boolean }): Promise<AgentAccount[]>;
}

/**
 * Caminho do executável para rodar sem shell. Um `.exe` em qualquer pasta do PATH ganha de um `.cmd` que venha antes
 * (o `node_modules/.bin` do daemon tem `codex.cmd`, o Codex instalado é `codex.exe`). Só sobra o `.cmd` se não houver exe.
 */
export function resolveVerifierCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return findExecutable(command, { ...env, PATHEXT: '.COM;.EXE' }, platform) ?? findExecutable(command, env, platform);
}

export function createAgentAccounts(options: AgentAccountsOptions): AgentAccountsService {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const resolve = options.resolve ?? ((command: string) => resolveVerifierCommand(command, options.env));
  const context: ProbeContext = {
    home: options.home ?? homedir(),
    env: options.env,
    timeoutMs,
    resolve,
    run: options.run ?? execCommand,
  };

  let cache: { at: number; accounts: AgentAccount[] } | undefined;
  let pending: Promise<AgentAccount[]> | undefined;

  async function probe(agentId: string, label: string): Promise<AgentAccount> {
    const verifier = Object.hasOwn(ACCOUNT_VERIFIERS, agentId) ? ACCOUNT_VERIFIERS[agentId] : undefined;
    const check = verifier === undefined ? NO_VERIFIER : await withLimit(verifier(context), timeoutMs);
    return { agentId, label, ...check, checkedAt: now() };
  }

  async function refreshAll(): Promise<AgentAccount[]> {
    const accounts = await Promise.all(Object.entries(options.agents).map(([id, agent]) => probe(id, agent.label)));
    cache = { at: now(), accounts };
    return accounts;
  }

  return {
    list({ refresh = false } = {}) {
      if (!refresh && cache !== undefined && now() - cache.at < ttlMs) return Promise.resolve(cache.accounts);
      pending ??= refreshAll().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
