import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentConfig, UsageResponse } from '@nanachi/shared';
import type { FastifyBaseLogger } from 'fastify';
import { restoreMethodOf } from './acp-mapping.js';
import type { AcpProcess } from './agent-process.js';

/** Erro de uma leitura de uso. O SessionManager o converte para SessionError (a rota responde o código). */
export class UsageProbeError extends Error {
  readonly code: 'agent_timeout' | 'agent_failed';

  constructor(code: 'agent_timeout' | 'agent_failed', message: string) {
    super(message);
    this.name = 'UsageProbeError';
    this.code = code;
  }
}

/** De quem é o processo de uso: o agente do config e a conta (`null` = a principal). */
export interface ProbeAccount {
  agentId: string;
  accountId: string | null;
}

export interface UsageProbeOptions {
  /**
   * `<NANACHI_HOME>/usage-probe`: cada agente tem uma pasta (cwd) e um arquivo com o id da sessão de uso. As contas
   * extras têm os delas, ao lado: `<agente>@<conta>` e `<agente>@<conta>.session`.
   */
  root: string;
  /**
   * Sobe o processo ACP do agente (ver SessionManager.spawnTemporary). Recebe cada update que o agente manda e de
   * qual conta o processo é (para apontar o agente para a pasta dela).
   */
  launch(
    agent: AgentConfig,
    cwd: string,
    onUpdate: (notification: acp.SessionNotification) => void,
    account: ProbeAccount,
  ): AcpProcess;
  /** Antes de subir o processo de uma conta extra: prepara a pasta do perfil. Falha vira `agent_failed`. */
  prepare?: ((agentId: string, accountId: string) => Promise<void>) | undefined;
  /**
   * An extra account that is being removed: a read or command for it is refused (`agent_failed`) before anything is
   * created, so the removal does not race a new slot, working folder or process for the account it is deleting.
   */
  blocked?: ((agentId: string, accountId: string) => boolean) | undefined;
  log: FastifyBaseLogger;
  /** Teto da leitura inteira (subir o processo, negociar e responder ao comando). */
  timeoutMs: number;
  /** Budget for one agent, when it differs from 	imeoutMs (a slow cold start). */
  timeoutFor?: ((agentId: string) => number) | undefined;
  /** Quanto tempo uma leitura fica no cache (leitura nova só depois disso). */
  cacheMs: number;
  /** Quanto tempo o processo de uso fica vivo sem ninguém pedir. */
  idleMs: number;
  /** Depois do session/cancel, tempo máximo de espera pelo fim do comando antes de matar o processo. */
  cancelGraceMs: number;
}

/** Processo de uso vivo de um agente, com a sessão ACP que ele usa para o comando. */
interface LiveProbe {
  process: AcpProcess;
  /** Id da sessão ACP de uso (criada ou carregada). Resolve depois do initialize. */
  session: Promise<string>;
  /** Texto do comando em andamento. Fora de um turno, o que o agente manda (replay do load, updates) é descartado. */
  reply: { active: boolean; text: string };
}

/**
 * Estado por agente e conta: o processo vivo, a leitura em curso, a última leitura, o timer de ociosidade e a fila de
 * turnos. Um turno por vez no processo: `tail` é o fim do último turno agendado (leitura de uso ou comando de resets).
 */
interface AgentSlot {
  live: LiveProbe | undefined;
  inFlight: Promise<UsageResponse> | undefined;
  cached: UsageResponse | undefined;
  idle: NodeJS.Timeout | undefined;
  tail: Promise<void>;
  /** Sobe a cada forget(): leitura que começou antes não grava o cache. */
  epoch: number;
  /** A conta saiu (drop): um turno que ainda esperava o preparo da pasta não sobe processo. */
  dropped: boolean;
  /** Turnos agendados e ainda não terminados (o que roda e o que espera na fila). */
  pending: number;
}

/** Marca de um turno: vira true quando estoura o tempo. Um turno abandonado não sobe processo depois do preparo. */
interface TurnState {
  abandoned: boolean;
}

/** Id da conta principal na chave do slot. */
const PRINCIPAL_KEY = 'default';

/** Chave do slot: `<agente>:<conta>`, com `default` para a principal. */
function probeKeyOf(agentId: string, accountId: string | null): string {
  return `${agentId}:${accountId ?? PRINCIPAL_KEY}`;
}

const TIMED_OUT = Symbol('timed-out');

/** Mensagem de erro de qualquer valor lançado. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A promessa, ou um erro se o processo sair antes dela. Não deixa rejeição sem tratador: `race` assina as duas. */
function untilExit<T>(process: AcpProcess, work: Promise<T>): Promise<T> {
  const died = process.exited.then(() => {
    throw new Error('processo de uso encerrou antes de responder');
  });
  return Promise.race([work, died]);
}

function noop(): void {
  return undefined;
}

/** Resolve quando `work` termina (ok ou erro) ou depois de `ms`, o que vier antes. Nunca rejeita. */
function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

/**
 * Leitura de uso do agente (`/usage` ou `/status`) num processo ACP próprio, independente das sessões do usuário.
 * Um processo vivo por agente, reaproveitado enquanto houver leituras dentro da janela de ociosidade; a sessão ACP de
 * uso é guardada em disco e carregada de novo quando o agente sabe retomar. Uma leitura por vez por agente: quem
 * chega enquanto uma roda recebe a mesma promessa. A última leitura fica em cache por `cacheMs`.
 * Nada do que o processo fala vira evento: só o texto do comando volta para quem pediu.
 */
export class UsageProbe {
  private readonly slots = new Map<string, AgentSlot>();

  constructor(private readonly options: UsageProbeOptions) {}

  /**
   * Leitura de uso do agente `agentId` (config `agent`) com o comando `command`. Cache: `cached: true` quando a
   * resposta é da janela de `cacheMs`. Sem resposta em `timeoutMs`: session/cancel e o processo morre.
   */
  read(agentId: string, agent: AgentConfig, command: string, accountId: string | null = null): Promise<UsageResponse> {
    const refused = this.refusalFor(agentId, accountId);
    if (refused !== undefined) return Promise.reject(refused);
    const slot = this.slotOf(agentId, accountId);
    const { cached } = slot;
    if (cached !== undefined && Date.now() - cached.fetchedAt < this.options.cacheMs) {
      return Promise.resolve({ ...cached, cached: true });
    }
    if (slot.inFlight === undefined) {
      const epochAtStart = slot.epoch;
      slot.inFlight = this.serial(slot, () => this.turn(agentId, accountId, slot, agent, command))
        .then((text) => {
          const reading: UsageResponse = { agent: agentId, text, fetchedAt: Date.now() };
          // Uma leitura que começou antes de forget() (um resgate) não vira cache: o uso mudou depois dela.
          if (slot.epoch === epochAtStart) slot.cached = reading;
          return reading;
        })
        .finally(() => {
          slot.inFlight = undefined;
        });
    }
    return slot.inFlight;
  }

  /**
   * Comando local no processo de uso (ex.: o texto `/usage reset`), sem cache e sem juntar chamadas: devolve o texto
   * do agente com ANSI. Mesmas regras de tempo, cancelamento e morte que `read`. Espera o turno em curso terminar.
   */
  command(agentId: string, agent: AgentConfig, text: string, accountId: string | null = null): Promise<string> {
    const refused = this.refusalFor(agentId, accountId);
    if (refused !== undefined) return Promise.reject(refused);
    const slot = this.slotOf(agentId, accountId);
    return this.serial(slot, () => this.turn(agentId, accountId, slot, agent, text));
  }

  /** A read or command of the account is running or queued (a usage read in flight, a resets turn). */
  isBusy(agentId: string, accountId: string): boolean {
    return (this.slots.get(probeKeyOf(agentId, accountId))?.pending ?? 0) > 0;
  }

  /** The error for an account that is being removed, or undefined. Checked before `slotOf`: no slot is created. */
  private refusalFor(agentId: string, accountId: string | null): UsageProbeError | undefined {
    if (accountId === null || this.options.blocked?.(agentId, accountId) !== true) return undefined;
    return new UsageProbeError('agent_failed', 'não foi possível ler o uso do agente: a conta está sendo removida');
  }

  /** Esquece a última leitura de uso do agente e conta (depois de um resgate, o uso mudou). */
  forget(agentId: string, accountId: string | null = null): void {
    const slot = this.slots.get(probeKeyOf(agentId, accountId));
    if (slot === undefined) return;
    slot.cached = undefined;
    slot.epoch += 1;
  }

  /**
   * A conta extra saiu (removida): mata o processo de uso dela e espera a saída (no Windows a pasta só se apaga sem
   * processo dentro), esquece o slot e apaga a pasta de trabalho e o arquivo da sessão de uso. A principal nunca sai.
   */
  async drop(agentId: string, accountId: string): Promise<void> {
    const key = probeKeyOf(agentId, accountId);
    const slot = this.slots.get(key);
    if (slot !== undefined) {
      this.slots.delete(key);
      slot.dropped = true;
      slot.cached = undefined;
      slot.epoch += 1;
      const live = slot.live;
      this.discard(slot);
      if (live !== undefined) await settledWithin(live.process.exited, this.options.cancelGraceMs);
    }
    const removal = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
    await rm(this.cwdOf(agentId, accountId), removal).catch(this.warnRemoval(agentId));
    await rm(this.sessionFile(agentId, accountId), removal).catch(this.warnRemoval(agentId));
  }

  private warnRemoval(agentId: string): (error: unknown) => void {
    return (error) => this.options.log.warn({ agent: agentId, reason: messageOf(error) }, 'não apagou a pasta de uso da conta');
  }

  /** Mata os processos de uso e cancela os timers de ociosidade (shutdown e reload do daemon). */
  close(): void {
    for (const slot of this.slots.values()) this.discard(slot);
  }

  private slotOf(agentId: string, accountId: string | null): AgentSlot {
    const key = probeKeyOf(agentId, accountId);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = {
        live: undefined,
        inFlight: undefined,
        cached: undefined,
        idle: undefined,
        tail: Promise.resolve(),
        epoch: 0,
        dropped: false,
        pending: 0,
      };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** Agenda `task` depois do último turno do agente: dois turnos nunca rodam sobre o mesmo processo. */
  private serial<T>(slot: AgentSlot, task: () => Promise<T>): Promise<T> {
    slot.pending += 1;
    const result = slot.tail.then(task);
    slot.tail = result.then(noop, noop);
    void slot.tail.then(() => {
      slot.pending -= 1;
    });
    return result;
  }

  /** Um turno com o teto de `timeoutMs`. Erros viram UsageProbeError (a rota responde o código). */
  private async turn(
    agentId: string,
    accountId: string | null,
    slot: AgentSlot,
    agent: AgentConfig,
    command: string,
  ): Promise<string> {
    this.clearIdle(slot);
    const limitMs = this.options.timeoutFor?.(agentId) ?? this.options.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), limitMs);
    });
    const state: TurnState = { abandoned: false };
    const work = this.run(agentId, accountId, slot, agent, command, state);
    try {
      const outcome = await Promise.race([work, timeout]);
      if (outcome === TIMED_OUT) {
        state.abandoned = true;
        await this.abandon(slot, work);
        throw new UsageProbeError('agent_timeout', `agente não respondeu ao ${command} em ${limitMs} ms`);
      }
      this.armIdle(slot);
      return outcome;
    } catch (error) {
      if (error instanceof UsageProbeError) throw error;
      this.discard(slot);
      const reason = messageOf(error);
      this.options.log.warn({ agent: agentId, account: accountId, reason }, 'leitura de uso do agente falhou');
      throw new UsageProbeError('agent_failed', `não foi possível ler o uso do agente: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sobe o processo se preciso, espera a sessão de uso e manda o comando. Devolve o texto que o agente respondeu. */
  private async run(
    agentId: string,
    accountId: string | null,
    slot: AgentSlot,
    agent: AgentConfig,
    command: string,
    state: TurnState,
  ): Promise<string> {
    let live = slot.live;
    if (live === undefined) {
      // Conta extra: a pasta do perfil se prepara antes do processo. Turno que estourou o tempo ou conta removida
      // nesse intervalo não sobe nada (o processo ficaria sem dono).
      if (accountId !== null) await this.options.prepare?.(agentId, accountId);
      if (state.abandoned || slot.dropped) throw new Error('leitura de uso abandonada antes de subir o processo');
      live = slot.live ?? this.spawn(agentId, accountId, slot, agent);
    }
    const sessionId = await untilExit(live.process, live.session);
    live.reply.text = '';
    live.reply.active = true;
    try {
      await untilExit(
        live.process,
        live.process.connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: command }],
        }),
      );
      return live.reply.text;
    } finally {
      live.reply.active = false;
    }
  }

  /** Sobe o processo do agente e deixa a negociação da sessão em `live.session`. Guarda o processo no slot já. */
  private spawn(agentId: string, accountId: string | null, slot: AgentSlot, agent: AgentConfig): LiveProbe {
    const cwd = this.cwdOf(agentId, accountId);
    mkdirSync(cwd, { recursive: true });
    const reply = { active: false, text: '' };
    const process = this.options.launch(
      agent,
      cwd,
      (notification) => {
        const update = notification.update;
        if (reply.active && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          reply.text += update.content.text;
        }
      },
      { agentId, accountId },
    );
    const live: LiveProbe = { process, session: this.openSession(agentId, accountId, process, cwd), reply };
    slot.live = live;
    void process.exited.then(() => {
      if (slot.live === live) slot.live = undefined;
    });
    return live;
  }

  /**
   * Initialize, depois session/load (ou session/resume) da sessão de uso salva, se o agente sabe retomar e a sessão
   * ainda existe. Senão, session/new; o id novo vai para o arquivo. Uma falha ao retomar cai no session/new.
   */
  private async openSession(agentId: string, accountId: string | null, process: AcpProcess, cwd: string): Promise<string> {
    const { connection } = process;
    const initialized = await untilExit(
      process,
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    );
    const method = restoreMethodOf(initialized.agentCapabilities);
    const saved = this.savedSessionId(agentId, accountId);
    if (saved !== undefined && method !== undefined) {
      const params = { sessionId: saved, cwd, mcpServers: [] };
      try {
        await untilExit(
          process,
          method === 'load'
            ? connection.agent.request(acp.methods.agent.session.load, params)
            : connection.agent.request(acp.methods.agent.session.resume, params),
        );
        return saved;
      } catch (error) {
        this.options.log.debug({ agent: agentId, reason: messageOf(error) }, 'sessão de uso salva não retomou');
      }
    }
    const created = await untilExit(
      process,
      connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }),
    );
    this.saveSessionId(agentId, accountId, created.sessionId);
    return created.sessionId;
  }

  /**
   * Session/cancel e espera curta pelo fim do comando; depois o processo morre. Um comando ainda não enviado
   * (processo subindo) não tem o que cancelar: só morre.
   */
  private async abandon(slot: AgentSlot, work: Promise<string>): Promise<void> {
    const live = slot.live;
    if (live !== undefined && live.reply.active) {
      // O turno só fica ativo depois de a sessão de uso estar resolvida.
      const sessionId = await live.session;
      await live.process.connection.agent
        .notify(acp.methods.agent.session.cancel, { sessionId })
        .catch((error: unknown) => this.options.log.warn({ reason: messageOf(error) }, 'session/cancel de uso falhou'));
      await settledWithin(work, this.options.cancelGraceMs);
    }
    this.discard(slot);
  }

  /** Depois de uma leitura bem-sucedida: o processo fica vivo `idleMs` e morre se ninguém pedir antes. */
  private armIdle(slot: AgentSlot): void {
    this.clearIdle(slot);
    const timer = setTimeout(() => this.discard(slot), this.options.idleMs);
    timer.unref();
    slot.idle = timer;
  }

  private clearIdle(slot: AgentSlot): void {
    if (slot.idle !== undefined) clearTimeout(slot.idle);
    slot.idle = undefined;
  }

  private discard(slot: AgentSlot): void {
    this.clearIdle(slot);
    const live = slot.live;
    slot.live = undefined;
    live?.process.kill();
  }

  /** Pasta de trabalho do processo de uso: a de sempre para a principal, `<agente>@<conta>` para uma conta extra. */
  private cwdOf(agentId: string, accountId: string | null): string {
    return join(this.options.root, accountId === null ? agentId : `${agentId}@${accountId}`);
  }

  private sessionFile(agentId: string, accountId: string | null): string {
    return `${this.cwdOf(agentId, accountId)}.session`;
  }

  private savedSessionId(agentId: string, accountId: string | null): string | undefined {
    try {
      const id = readFileSync(this.sessionFile(agentId, accountId), 'utf8').trim();
      return id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  private saveSessionId(agentId: string, accountId: string | null, sessionId: string): void {
    try {
      writeFileSync(this.sessionFile(agentId, accountId), sessionId, 'utf8');
    } catch (error) {
      this.options.log.warn({ agent: agentId, reason: messageOf(error) }, 'não gravou a sessão de uso');
    }
  }
}
