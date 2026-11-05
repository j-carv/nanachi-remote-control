import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export interface UsageProbeOptions {
  /** `<NANACHI_HOME>/usage-probe`: cada agente tem uma pasta (cwd) e um arquivo com o id da sessão de uso. */
  root: string;
  /** Sobe o processo ACP do agente (ver SessionManager.spawnTemporary). Recebe cada update que o agente manda. */
  launch(agent: AgentConfig, cwd: string, onUpdate: (notification: acp.SessionNotification) => void): AcpProcess;
  log: FastifyBaseLogger;
  /** Teto da leitura inteira (subir o processo, negociar e responder ao comando). */
  timeoutMs: number;
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

/** Estado por agente: o processo vivo, a leitura em curso, a última leitura e o timer de ociosidade. */
interface AgentSlot {
  live: LiveProbe | undefined;
  inFlight: Promise<UsageResponse> | undefined;
  cached: UsageResponse | undefined;
  idle: NodeJS.Timeout | undefined;
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
  read(agentId: string, agent: AgentConfig, command: string): Promise<UsageResponse> {
    const slot = this.slotOf(agentId);
    const { cached } = slot;
    if (cached !== undefined && Date.now() - cached.fetchedAt < this.options.cacheMs) {
      return Promise.resolve({ ...cached, cached: true });
    }
    if (slot.inFlight === undefined) {
      slot.inFlight = this.fetch(agentId, slot, agent, command)
        .then((reading) => {
          slot.cached = reading;
          return reading;
        })
        .finally(() => {
          slot.inFlight = undefined;
        });
    }
    return slot.inFlight;
  }

  /** Mata os processos de uso e cancela os timers de ociosidade (shutdown e reload do daemon). */
  close(): void {
    for (const slot of this.slots.values()) this.discard(slot);
  }

  private slotOf(agentId: string): AgentSlot {
    let slot = this.slots.get(agentId);
    if (slot === undefined) {
      slot = { live: undefined, inFlight: undefined, cached: undefined, idle: undefined };
      this.slots.set(agentId, slot);
    }
    return slot;
  }

  private async fetch(agentId: string, slot: AgentSlot, agent: AgentConfig, command: string): Promise<UsageResponse> {
    this.clearIdle(slot);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.options.timeoutMs);
    });
    const work = this.run(agentId, slot, agent, command);
    try {
      const outcome = await Promise.race([work, timeout]);
      if (outcome === TIMED_OUT) {
        await this.abandon(slot, work);
        throw new UsageProbeError('agent_timeout', `agente não respondeu ao ${command} em ${this.options.timeoutMs} ms`);
      }
      this.armIdle(slot);
      return { agent: agentId, text: outcome, fetchedAt: Date.now() };
    } catch (error) {
      if (error instanceof UsageProbeError) throw error;
      this.discard(slot);
      const reason = messageOf(error);
      this.options.log.warn({ agent: agentId, reason }, 'leitura de uso do agente falhou');
      throw new UsageProbeError('agent_failed', `não foi possível ler o uso do agente: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sobe o processo se preciso, espera a sessão de uso e manda o comando. Devolve o texto que o agente respondeu. */
  private async run(agentId: string, slot: AgentSlot, agent: AgentConfig, command: string): Promise<string> {
    const live = slot.live ?? this.spawn(agentId, slot, agent);
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
  private spawn(agentId: string, slot: AgentSlot, agent: AgentConfig): LiveProbe {
    const cwd = join(this.options.root, agentId);
    mkdirSync(cwd, { recursive: true });
    const reply = { active: false, text: '' };
    const process = this.options.launch(agent, cwd, (notification) => {
      const update = notification.update;
      if (reply.active && update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        reply.text += update.content.text;
      }
    });
    const live: LiveProbe = { process, session: this.openSession(agentId, process, cwd), reply };
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
  private async openSession(agentId: string, process: AcpProcess, cwd: string): Promise<string> {
    const { connection } = process;
    const initialized = await untilExit(
      process,
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    );
    const method = restoreMethodOf(initialized.agentCapabilities);
    const saved = this.savedSessionId(agentId);
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
    this.saveSessionId(agentId, created.sessionId);
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

  private sessionFile(agentId: string): string {
    return join(this.options.root, `${agentId}.session`);
  }

  private savedSessionId(agentId: string): string | undefined {
    try {
      const id = readFileSync(this.sessionFile(agentId), 'utf8').trim();
      return id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  private saveSessionId(agentId: string, sessionId: string): void {
    try {
      writeFileSync(this.sessionFile(agentId), sessionId, 'utf8');
    } catch (error) {
      this.options.log.warn({ agent: agentId, reason: messageOf(error) }, 'não gravou a sessão de uso');
    }
  }
}
