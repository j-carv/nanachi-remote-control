import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig, ResetRedeemResponse, ResetsResponse } from '@nanachi/shared';
import type { FastifyBaseLogger } from 'fastify';
import {
  CodexAppServerError,
  withCodexAppServer,
  type CodexAppServerOptions,
} from './codex-app-server.js';
import { UsageProbeError, type UsageProbe } from './usage-probe.js';
import {
  codexRedeemResponse,
  codexResetsView,
  NEXT_CREDIT_TARGET,
  OMP_RESET_LIST_COMMAND,
  ompRedeemOutcome,
  ompRedeemPrompt,
  parseOmpResetList,
  resetSourceOf,
  type ResetSource,
} from './usage-resets.js';

/** Erros dos resets. O SessionManager converte para SessionError (a rota responde o código). */
export type ResetErrorCode = 'resets_unsupported' | 'invalid_request' | 'reset_in_progress' | 'agent_timeout' | 'agent_failed';

export class ResetError extends Error {
  readonly code: ResetErrorCode;

  constructor(code: ResetErrorCode, message: string) {
    super(message);
    this.name = 'ResetError';
    this.code = code;
  }
}

export interface ResetServiceOptions {
  /** Processo de uso do omp (comando `/usage reset`) e o esquecimento do uso depois de um resgate. */
  usage: Pick<UsageProbe, 'command' | 'forget'>;
  /** `<NANACHI_HOME>/usage-probe`: pasta de trabalho do processo do codex (uma subpasta por agente). */
  workRoot: string;
  /** Versão do daemon, mandada ao app-server em clientInfo. */
  appVersion: string;
  /** Teto de cada operação (leitura ou resgate). */
  timeoutMs: number;
  /** Quanto tempo uma listagem fica no cache. */
  cacheMs: number;
  log: Pick<FastifyBaseLogger, 'warn' | 'debug'>;
}

/**
 * Quem tem os resets: o agente e, no codex, a conta. `accountKey`, `accountId`, `extraEnv` e `prepare` só valem para o
 * codex (contas extras: a chave do cache e do resgate em curso, a conta do cache de uso, a home da conta no env do
 * app-server e o preparo da pasta dela). O omp não tem contas no Nanachi (ele mesmo guarda várias): o serviço ignora
 * esses campos nele, então a chave, o processo de uso e o resgate em curso são sempre os do agente.
 */
export interface ResetTarget {
  /** Id do agente no config (omp ou codex). */
  agentId: string;
  agent: AgentConfig;
  accountKey?: string | undefined;
  /** Conta extra do codex (`null`/ausente = principal): de quem é o cache de uso que um resgate esquece. */
  accountId?: string | null | undefined;
  extraEnv?: NodeJS.ProcessEnv | undefined;
  /** Antes de subir o app-server do codex: prepara a pasta da conta extra. */
  prepare?: (() => Promise<void>) | undefined;
}

/** Uma listagem em andamento e quantos resgates da chave tinham terminado quando ela começou. */
interface ListingInFlight {
  promise: Promise<ResetsResponse>;
  redeemsAtStart: number;
}

/** O que uma leitura traz: a resposta e, no codex, os ids de crédito que ela viu. */
interface Listing {
  response: ResetsResponse;
  knownIds: ReadonlySet<string> | undefined;
}

/**
 * Listagem e resgate de resets salvos (docs/PLAN.md, "rate-limit resets in the usage drawer"). O omp responde por texto
 * no processo de uso; o codex pelo app-server. Cache de listagem por `cacheMs`, uma listagem por vez por chave (quem
 * chega junto recebe a mesma), e no máximo um resgate por chave: um segundo chega como `reset_in_progress`.
 * Um resgate muda os créditos: uma listagem que começou antes do fim dele não é juntada depois e não grava cache nem ids.
 */
export class ResetService {
  private readonly cache = new Map<string, ResetsResponse>();
  private readonly listings = new Map<string, ListingInFlight>();
  private readonly redeeming = new Set<string>();
  /** Ids de crédito da última listagem de cada chave: o único conjunto que um resgate com id aceita. */
  private readonly knownCredits = new Map<string, ReadonlySet<string>>();
  /** Quantos resgates terminaram por chave. */
  private readonly redeemsDone = new Map<string, number>();
  /** Aborta os app-servers do codex em andamento (o daemon encerra ou recarrega). */
  private readonly shutdown = new AbortController();

  constructor(private readonly options: ResetServiceOptions) {}

  /** Mata o app-server do codex que estiver em andamento e impede novos: o daemon está encerrando ou recarregando. */
  close(): void {
    this.shutdown.abort();
  }

  /** Esquece o que se sabe de uma chave de conta (conta removida): listagem em cache e ids de crédito da listagem. */
  dropKey(key: string): void {
    this.cache.delete(key);
    this.knownCredits.delete(key);
    this.redeemsDone.delete(key);
  }

  /** Resets salvos do alvo. `cached: true` quando a resposta vem da janela de `cacheMs`. */
  async list(target: ResetTarget): Promise<ResetsResponse> {
    const source = sourceOf(target);
    const key = keyOf(target);
    const cached = this.cache.get(key);
    if (cached !== undefined && Date.now() - cached.fetchedAt < this.options.cacheMs) {
      return Promise.resolve({ ...cached, cached: true });
    }
    const redeemsAtStart = this.redeemsOf(key);
    const running = this.listings.get(key);
    if (running !== undefined && running.redeemsAtStart === redeemsAtStart) return running.promise;

    // A redeem ended since `running` began: its answer may predate it, so this request reads again.
    const promise: Promise<ResetsResponse> = this.fetchListing(source, target)
      .then((listing) => {
        if (this.redeemsOf(key) === redeemsAtStart) {
          this.cache.set(key, listing.response);
          if (listing.knownIds !== undefined) this.knownCredits.set(key, listing.knownIds);
        }
        return listing.response;
      })
      .finally(() => {
        if (this.listings.get(key)?.promise === promise) this.listings.delete(key);
      });
    this.listings.set(key, { promise, redeemsAtStart });
    return promise;
  }

  /**
   * Gasta um reset. `targetId` é o alvo de uma linha da listagem. Sempre esquece o cache de uso e de resets do alvo,
   * com sucesso ou não. Um segundo resgate da mesma chave enquanto um roda → `reset_in_progress`, sem enviar nada.
   */
  async redeem(target: ResetTarget, targetId: string): Promise<ResetRedeemResponse> {
    const source = sourceOf(target);
    const key = keyOf(target);
    if (source === 'omp' && ompRedeemPrompt(targetId) === undefined) {
      throw new ResetError('invalid_request', 'alvo de reset inválido');
    }
    if (source === 'codex' && targetId !== NEXT_CREDIT_TARGET && !(this.knownCredits.get(key)?.has(targetId) ?? false)) {
      throw new ResetError('invalid_request', 'alvo de reset fora da última listagem');
    }
    if (this.redeeming.has(key)) throw new ResetError('reset_in_progress', 'já tem um reset em andamento');

    this.redeeming.add(key);
    try {
      return await this.guard(target, () =>
        source === 'omp' ? this.redeemOmp(target, targetId) : this.redeemCodex(target, targetId),
      );
    } catch (error) {
      // 504: the command may or may not have reached the account, and the daemon never sends it twice. Nothing but the
      // agent and the source goes in the log: not the target, not the idempotency key.
      if (error instanceof ResetError && error.code === 'agent_timeout') {
        this.options.log.warn({ agent: target.agentId, source }, 'reset outcome unknown');
      }
      throw error;
    } finally {
      this.redeeming.delete(key);
      this.redeemsDone.set(key, this.redeemsOf(key) + 1);
      this.cache.delete(key);
      this.options.usage.forget(target.agentId, probeAccountOf(target));
    }
  }

  private redeemsOf(key: string): number {
    return this.redeemsDone.get(key) ?? 0;
  }

  private async fetchListing(source: ResetSource, target: ResetTarget): Promise<Listing> {
    if (source === 'omp') {
      const text = await this.guard(target, () =>
        this.options.usage.command(target.agentId, target.agent, OMP_RESET_LIST_COMMAND, null),
      );
      const parsed = parseOmpResetList(text);
      const response = { agent: target.agentId, entries: parsed.entries, message: parsed.message, fetchedAt: Date.now() };
      return { response, knownIds: undefined };
    }
    const { account, limits } = await this.guard(target, async () => {
      await this.prepare(target);
      return withCodexAppServer(this.codexOptions(target), async (client) => ({
        account: await client.accountRead(),
        limits: await client.rateLimitsRead(),
      }));
    });
    const view = codexResetsView(account.email, limits.rateLimitResetCredits);
    const response = { agent: target.agentId, entries: view.entries, message: view.message, fetchedAt: Date.now() };
    return { response, knownIds: new Set(view.knownIds) };
  }

  private redeemOmp(target: ResetTarget, targetId: string): Promise<ResetRedeemResponse> {
    const prompt = ompRedeemPrompt(targetId);
    if (prompt === undefined) throw new ResetError('invalid_request', 'alvo de reset inválido');
    return this.options.usage.command(target.agentId, target.agent, prompt, null).then(ompRedeemOutcome);
  }

  private async redeemCodex(target: ResetTarget, targetId: string): Promise<ResetRedeemResponse> {
    // Uma chave nova por POST: o backend deduplica pela chave, e o daemon nunca manda o mesmo resgate duas vezes.
    const idempotencyKey = randomUUID();
    const params = targetId === NEXT_CREDIT_TARGET ? { idempotencyKey } : { idempotencyKey, creditId: targetId };
    try {
      await this.prepare(target);
      const outcome = await withCodexAppServer(this.codexOptions(target), (client) =>
        client.consumeResetCredit(params),
      );
      return codexRedeemResponse(outcome);
    } catch (error) {
      // Erro JSON-RPC: o servidor respondeu que não deu. O texto dele vai para o log, não para a resposta.
      if (error instanceof CodexAppServerError && error.kind === 'rpc') {
        this.options.log.warn({ agent: target.agentId, reason: error.message }, 'resgate de reset do codex falhou');
        return codexRedeemResponse('failed');
      }
      throw error;
    }
  }

  /** Preparo da pasta da conta (codex). Falha vira `agent_failed`, e a causa vai para o log. */
  private async prepare(target: ResetTarget): Promise<void> {
    try {
      await target.prepare?.();
    } catch (error) {
      this.options.log.warn(
        { agent: target.agentId, reason: error instanceof Error ? error.message : String(error) },
        'preparo da conta para os resets falhou',
      );
      throw new ResetError('agent_failed', 'não foi possível preparar a conta para os resets');
    }
  }

  /** Traduz os erros de processo e de protocolo para ResetError, e registra a causa no log (nunca no corpo). */
  private async guard<T>(target: ResetTarget, task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof ResetError) throw error;
      if (error instanceof UsageProbeError) throw new ResetError(error.code, error.message);
      if (error instanceof CodexAppServerError) {
        this.options.log.warn({ agent: target.agentId, reason: error.message }, 'operação de reset do codex falhou');
        const code = error.kind === 'timeout' ? 'agent_timeout' : 'agent_failed';
        throw new ResetError(code, 'não foi possível falar com o agente sobre os resets');
      }
      throw error;
    }
  }

  private codexOptions(target: ResetTarget): CodexAppServerOptions {
    const cwd = join(this.options.workRoot, target.agentId);
    mkdirSync(cwd, { recursive: true });
    return {
      agent: target.agent,
      cwd,
      timeoutMs: this.options.timeoutMs,
      appVersion: this.options.appVersion,
      // Só o codex passa por aqui; o env extra é a pasta da conta dele.
      extraEnv: target.extraEnv,
      signal: this.shutdown.signal,
      onDiagnostic: (line) => this.options.log.debug({ agent: target.agentId }, line),
    };
  }
}

/** Fonte de resets do alvo; agente sem fonte (claude, agy, shell, ids desconhecidos) → resets_unsupported. */
function sourceOf(target: ResetTarget): ResetSource {
  const source = resetSourceOf(target.agentId);
  if (source === undefined) throw new ResetError('resets_unsupported', 'agente sem resets salvos');
  return source;
}

/** Chave do cache, da listagem e do resgate em curso. omp: sempre o agente (sem contas). codex: a da conta, ou o agente. */
function keyOf(target: ResetTarget): string {
  if (resetSourceOf(target.agentId) === 'omp') return target.agentId;
  return target.accountKey ?? target.agentId;
}

/** Conta do processo de uso que um resgate esquece: só o codex tem contas; omp é sempre a principal do agente. */
function probeAccountOf(target: ResetTarget): string | null {
  if (resetSourceOf(target.agentId) === 'omp') return null;
  return target.accountId ?? null;
}
