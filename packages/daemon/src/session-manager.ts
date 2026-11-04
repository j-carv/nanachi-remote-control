import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import {
  SessionEventSchema,
  type AgentConfig,
  type AgentSessionsResponse,
  type AvailableCommand,
  type ConfigValue,
  type CreateSessionRequest,
  type FileInfo,
  type ServerMessage,
  type Session,
  type SessionConfigOption,
  type SessionEvent,
  type SessionStatus,
  type Workspace,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  availableCommandsOf,
  flattenConfigOptions,
  type ImageSink,
  isPromptImage,
  isSlashCommand,
  listedUpdatedAt,
  MODE_OPTION_ID,
  modeConfigOption,
  newestFirst,
  PHONE_SEND_HINT,
  promptBlocks,
  restoreMethodOf,
  sameWorkingDirectory,
  sessionUpdateToDraft,
  titleFromPrompt,
  toolContentOf,
  type EventDraft,
  type PromptAttachment,
  type RestoreMethod,
} from './acp-mapping.js';
import { AgentImages } from './agent-images.js';
import { agentBinDirs, phoneSendBinDir, withPathPrepended } from './agent-path.js';
import { AgentTokens } from './agent-tokens.js';
import { resolveAgentCommand, type AgentCommand } from './agent-command.js';
import { connectAcp, killAgent, spawnAgent, type AgentChild } from './agent-process.js';
import type { LoadedConfig } from './config.js';
import { toFileInfo } from './files.js';
import { addWorktree, deleteMergedBranch, hasCommits, isGitRepo, isWorktreeDirty, pruneWorktrees, removeWorktree } from './git.js';
import { notifyOf, type NotifyHandler } from './notify.js';
import { spawnTerminal as spawnPty, type TerminalProcess } from './pty-process.js';
import {
  countLiveSessions,
  deleteSessionRows,
  dropOldestTerminalOutput,
  findAcpLinks,
  findAcpSessionId,
  findFileById,
  findSessionById,
  findSessionCommands,
  findWorkspaceById,
  insertEvent,
  insertSession,
  updateSession,
  type FileRecord,
  type Worktree,
} from './repository.js';
import { OutputBatcher, TERMINAL_RETENTION_BYTES } from './terminal-output.js';

export const DEFAULT_TITLE = 'Nova sessão';
/** Teto de sessões vivas (não stopped/error) por daemon: cada uma é um processo (agente ACP ou terminal). */
export const MAX_LIVE_SESSIONS = 8;
const START_TIMEOUT_MS = 60_000;
const KILL_TIMEOUT_MS = 5_000;
/** Tamanho inicial do PTY; o PWA manda `terminal_resize` depois. */
const TERMINAL_COLS = 80;
const TERMINAL_ROWS = 24;
/** Mensagem quando o terminal morreu entre a checagem e a entrada/redimensionamento. */
const TERMINAL_GONE = 'terminal não está mais ativo';
/** Status sem processo: a sessão está parada ou com erro, e pode ser retomada. */
const TERMINAL_STATUSES: readonly SessionStatus[] = ['stopped', 'error'];
/** Título de sessão importada quando o cliente não manda o da listagem. */
export const RESUMED_TITLE = 'Sessão retomada';
/** Eventos do histórico reenviado que a importação grava; o resto é descartado com um aviso `error`. */
export const IMPORT_HISTORY_LIMIT = 5_000;
/** Tempo total de uma listagem (`agent-sessions`): sobe o agente, negocia e lê as páginas. */
const LIST_TIMEOUT_MS = 30_000;
/** Páginas do session/list lidas por pedido. Páginas vazias do filtro de pasta contam. */
const LIST_MAX_PAGES = 5;

export type SessionErrorCode =
  | 'not_found'
  | 'unknown_agent'
  | 'invalid_request'
  | 'session_busy'
  | 'too_many_sessions'
  | 'already_running'
  | 'already_linked'
  | 'busy'
  | 'agent_timeout'
  | 'agent_failed'
  | 'not_resumable'
  | 'not_acp'
  | 'not_pty'
  | 'not_git'
  | 'no_commits'
  | 'worktree_failed'
  | 'worktree_dirty';

/** Erro esperado de comando (vira 4xx/5xx no HTTP e `error` no WS). Outros erros são bugs. */
export class SessionError extends Error {
  readonly code: SessionErrorCode;
  /** Campos extras do corpo HTTP, junto de `error` (ex.: `sessionId` no 409 de sessão já ligada). */
  readonly details: Readonly<Record<string, string>>;

  constructor(code: SessionErrorCode, message: string, details: Readonly<Record<string, string>> = {}) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.details = details;
  }
}

/** Quem assina uma sessão recebe os eventos (histórico e ao vivo) e cada lista nova de comandos. */
export interface SessionListener {
  event(event: SessionEvent): void;
  commands(commands: AvailableCommand[]): void;
}

export interface SessionManagerOptions {
  db: Database.Database;
  config: LoadedConfig;
  log: FastifyBaseLogger;
  /** Manda uma mensagem a todos os clientes WS autenticados. */
  broadcast(message: ServerMessage): void;
  /** Base HTTP que o agente usa para falar com o daemon (`NANACHI_URL`, ex.: http://127.0.0.1:7777). */
  agentApiUrl(): string;
  /** Aviso para turn_end, permission_request, error e file (o Web Push entra aqui depois). */
  onNotify?: NotifyHandler | undefined;
  /** `<NANACHI_HOME>/worktrees`: cada worktree vai em `<raiz>/<workspaceId>/<8 chars do id da sessão>`. */
  worktreesRoot: string;
  /** `<NANACHI_HOME>/files`, absoluto: onde ficam as imagens que o agente manda. */
  filesRoot: string;
  /** Teto da listagem de sessões do agente. Padrão: 30 s. Testes usam valor curto. */
  agentListTimeoutMs?: number | undefined;
}

/** Pedido de importação: `CreateSessionRequest` com a sessão do agente a retomar. */
export type ImportSessionInput = CreateSessionRequest & { resumeAcpSessionId: string };

/** Histórico reenviado pelo session/load, enquanto a importação grava (só existe durante esse replay). */
interface HistoryRecord {
  /** Eventos gravados até agora, contados contra IMPORT_HISTORY_LIMIT. */
  recorded: number;
  truncated: boolean;
  /** Texto de mensagem do usuário ainda sem evento: chunks seguidos viram um user_message só. */
  pendingUser: string | undefined;
}

/** Processo ainda não encerrado (ACP ou terminal), com o que é preciso para matá-lo e esperar a saída. */
interface RunningProcess {
  kill(): void;
  readonly exited: Promise<void>;
}

/** Sessão de terminal (kind pty) com processo vivo. */
interface LiveTerminal {
  readonly id: string;
  readonly process: TerminalProcess;
  readonly batcher: OutputBatcher;
  readonly exited: Promise<void>;
  /** Bytes de `data` de terminal_output gravados e ainda no banco (a sessão só grava por este terminal). */
  retainedBytes: number;
}

interface PendingPermission {
  requestId: string;
  optionIds: readonly string[];
  resolve(optionId: string | null): void;
}

/** Estado em memória de uma sessão com processo vivo. O banco é a fonte para o resto. */
interface LiveSession {
  readonly id: string;
  readonly child: AgentChild;
  readonly connection: acp.ClientConnection;
  /** Resolve quando o processo sai (ou falha ao subir). Usado para esperar o kill. */
  readonly exited: Promise<void>;
  acpSessionId: string | undefined;
  configOptions: SessionConfigOption[];
  /** Agente anunciou só `modes`: a opção "mode" foi sintetizada e troca por session/set_mode. */
  usesSetMode: boolean;
  status: SessionStatus;
  promptInFlight: boolean;
  pending: PendingPermission | undefined;
  /** Entre session/load e a resposta dele: os updates reenviados são descartados (o banco já tem o histórico). */
  replaying: boolean;
  /** `promptCapabilities.image` do initialize: imagens de anexo vão inline no prompt. */
  promptImage: boolean;
  /** Só na importação: o replay do load vira eventos em vez de ser descartado. */
  history: HistoryRecord | undefined;
  /** Sessão criada pelo app e ainda sem primeiro prompt: esse prompt leva o aviso do phone-send. */
  phoneHintPending: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout (${ms} ms) em ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  return code !== null ? `código ${code}` : `sinal ${signal ?? 'desconhecido'}`;
}

/**
 * Sessões de agente: um processo ACP por sessão, eventos gravados em `events` e enviados a quem assina.
 * Regra de concorrência: todo callback assíncrono confere `isCurrent(live)` antes de tocar no estado,
 * porque stop/shutdown já tiraram a sessão do mapa.
 */
export class SessionManager {
  private readonly live = new Map<string, LiveSession>();
  /** Sessões de terminal (kind pty) com PTY vivo. */
  private readonly terminals = new Map<string, LiveTerminal>();
  /**
   * Todo processo ainda não encerrado, inclusive os de sessões já tiradas do mapa (falhas). Sem isso,
   * um agente que falhou e continua vivo escaparia do shutdown e seguraria o diretório do workspace.
   */
  private readonly running = new Set<RunningProcess>();
  private readonly listeners = new Map<string, Set<SessionListener>>();
  /**
   * Vagas reservadas: criações e retomadas em curso, ainda sem linha viva no banco (o worktree é criado com await),
   * mas já contam para o teto de sessões.
   */
  private readonly reserved = new Set<string>();
  private readonly agentTokens = new AgentTokens();
  /** Agentes com uma listagem em andamento (no máximo uma por agente). */
  private readonly listing = new Set<string>();
  private readonly agentListTimeoutMs: number;
  private readonly agentImages: AgentImages;

  constructor(private readonly options: SessionManagerOptions) {
    this.agentListTimeoutMs = options.agentListTimeoutMs ?? LIST_TIMEOUT_MS;
    this.agentImages = new AgentImages({
      db: options.db,
      filesRoot: options.filesRoot,
      allowedRoots: options.config.allowedRoots,
      log: options.log,
    });
  }

  async create(input: CreateSessionRequest): Promise<Session> {
    if (input.resumeAcpSessionId !== undefined) {
      return this.importSession({ ...input, resumeAcpSessionId: input.resumeAcpSessionId });
    }
    const { db } = this.options;
    const workspace = findWorkspaceById(db, input.workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    const agent = this.agentOf(input.agent);
    this.requireFreeSlot();

    const id = randomUUID();
    // Reserva a vaga já: o worktree é criado com await, e outra criação não pode passar do teto nesse intervalo.
    this.reserved.add(id);
    let worktree: Worktree | null;
    try {
      worktree = input.worktree === true ? await this.createWorktree(workspace, id) : null;
      insertSession(db, {
        id,
        workspaceId: workspace.id,
        agent: input.agent,
        kind: agent.kind,
        title: DEFAULT_TITLE,
        status: 'starting',
        createdAt: Date.now(),
        worktree,
      });
    } finally {
      this.reserved.delete(id);
    }
    this.announceStatus(id, 'starting');

    const cwd = worktree?.path ?? workspace.path;
    // Terminal não tem configOptions: `config` do pedido é ignorado para kind pty.
    if (agent.kind === 'pty') this.startTerminal(id, cwd, agent);
    else await this.start(id, cwd, agent, input.config ?? {});
    return this.load(id);
  }

  /**
   * Worktree git separado para a sessão: `git worktree add -b nanachi/<8> <raiz>/<workspaceId>/<8> HEAD`.
   * Workspace fora do git ou sem commit é recusado antes de qualquer coisa ser criada.
   */
  private async createWorktree(workspace: Workspace, sessionId: string): Promise<Worktree> {
    if (!(await isGitRepo(workspace.path))) throw new SessionError('not_git', 'workspace não é um repositório git');
    if (!(await hasCommits(workspace.path))) {
      throw new SessionError('no_commits', 'repositório sem commits: faça o primeiro commit para usar worktree');
    }
    const short = sessionId.slice(0, 8);
    const path = join(this.options.worktreesRoot, workspace.id, short);
    const branch = `nanachi/${short}`;
    try {
      await addWorktree(workspace.path, path, branch);
    } catch (error) {
      throw new SessionError('worktree_failed', `git worktree add falhou: ${messageOf(error)}`);
    }
    return { path, branch };
  }

  /**
   * Remove o worktree da sessão e apaga a branch dele se já estiver mergeada. Quem chama para a sessão antes.
   * Com alterações não commitadas → `worktree_dirty`, e nada é apagado. Pasta que já sumiu só limpa o registro do git.
   */
  async removeWorktree(sessionId: string): Promise<void> {
    const session = this.load(sessionId);
    if (session.worktree === null) return;
    const workspace = findWorkspaceById(this.options.db, session.workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    const { path, branch } = session.worktree;

    if (existsSync(path)) {
      if (await isWorktreeDirty(path)) {
        throw new SessionError('worktree_dirty', 'worktree tem alterações não commitadas: não foi removido');
      }
      try {
        await removeWorktree(workspace.path, path);
      } catch (error) {
        throw new SessionError('worktree_failed', `git worktree remove falhou: ${messageOf(error)}`);
      }
    } else {
      await pruneWorktrees(workspace.path).catch(() => undefined);
    }
    // `branch -d` recusa branch com commits que não estão no HEAD: nesse caso a branch fica, de propósito.
    await deleteMergedBranch(workspace.path, branch).catch(() => undefined);
  }

  /**
   * Sobe o agente de uma sessão `stopped`/`error`, negocia `session/load` (ou `session/resume`) e volta a idle.
   * Se o agente não sabe retomar, o processo morre e a sessão fica como estava (409). Falha depois disso vira
   * status `error` com evento. Devolve a sessão como ficou no banco.
   * `markStarting`: grava `starting` enquanto o agente carrega a sessão (retomada automática depois de reload).
   */
  async resume(sessionId: string, options: { markStarting?: boolean } = {}): Promise<Session> {
    const { db } = this.options;
    const session = this.load(sessionId);
    if (this.isLive(sessionId) || !TERMINAL_STATUSES.includes(session.status)) {
      throw new SessionError('already_running', 'sessão já está ativa');
    }
    if (session.kind === 'pty') {
      throw new SessionError('not_resumable', 'terminal não retoma: abra uma sessão nova');
    }
    const acpSessionId = findAcpSessionId(db, sessionId);
    if (acpSessionId === undefined) {
      throw new SessionError('not_resumable', 'sessão nunca abriu no agente: não há o que retomar');
    }
    const workspace = findWorkspaceById(db, session.workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    const agent = this.agentOf(session.agent);
    this.requireFreeSlot();

    const cwd = session.worktree?.path ?? workspace.path;
    if (!existsSync(cwd)) {
      this.markFailed(sessionId, `pasta não existe mais: ${cwd}`);
      return this.load(sessionId);
    }

    this.reserved.add(sessionId);
    try {
      await this.restore(sessionId, cwd, agent, acpSessionId, session.configOptions, options.markStarting === true);
    } finally {
      this.reserved.delete(sessionId);
    }
    return this.load(sessionId);
  }

  /** Pasta onde a sessão roda: a do workspace (por enquanto; worktree entra na próxima etapa). */
  workingDirectory(sessionId: string): string {
    const session = this.load(sessionId);
    const workspace = findWorkspaceById(this.options.db, session.workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    return session.worktree?.path ?? workspace.path;
  }

  /** Assina os eventos de uma sessão. Devolve a função que cancela a assinatura. */
  subscribe(sessionId: string, listener: SessionListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<SessionListener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  /**
   * Manda um turno ao agente. `attachmentIds` são arquivos que o celular enviou antes para esta sessão: imagem
   * vai inline se o agente aceita; o resto (e imagem sem essa capacidade) entra no texto como caminho.
   * Validação e leitura acontecem antes da conferência de estado; depois dela não há await.
   */
  async prompt(sessionId: string, text: string, attachmentIds: readonly string[] = []): Promise<void> {
    this.requireAcp(sessionId);
    const records = this.attachmentRecords(sessionId, attachmentIds);
    const attachments = await this.loadAttachments(this.requireLive(sessionId), records);

    const live = this.requireLive(sessionId);
    if (live.status !== 'idle' || live.acpSessionId === undefined) {
      throw new SessionError('session_busy', `sessão não está ociosa (status: ${live.status})`);
    }
    const acpSessionId = live.acpSessionId;

    const first = records[0];
    const title = titleFromPrompt(text) ?? (first === undefined ? undefined : titleFromPrompt(first.name));
    const infos: FileInfo[] = records.map(toFileInfo);
    this.appendEvent(sessionId, {
      kind: 'user_message',
      text,
      ...(infos.length > 0 ? { attachments: infos } : {}),
    });
    const session = this.load(sessionId);
    if (session.title === DEFAULT_TITLE && title !== undefined) {
      updateSession(this.options.db, sessionId, { title }, Date.now());
      this.broadcastSession(sessionId);
    }

    // O aviso do phone-send vai só no primeiro prompt de sessão criada pelo app, e só se o config deixar.
    // Prompt de comando (`/loop ...`) não leva o aviso e não o consome: o agente lê o comando no começo do texto.
    const command = isSlashCommand(text);
    const hint = live.phoneHintPending && !command && this.options.config.phoneSendHint ? PHONE_SEND_HINT : undefined;
    if (!command) live.phoneHintPending = false;
    live.promptInFlight = true;
    this.setStatus(sessionId, 'running');
    live.connection.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId: acpSessionId,
        prompt: promptBlocks(text, attachments, hint),
      })
      .then(
        (response) => {
          if (!this.isCurrent(live)) return;
          live.promptInFlight = false;
          this.appendEvent(sessionId, { kind: 'turn_end', stopReason: response.stopReason });
          this.setStatus(sessionId, 'idle');
        },
        (error: unknown) => {
          if (!this.isCurrent(live)) return;
          live.promptInFlight = false;
          this.appendEvent(sessionId, { kind: 'error', message: messageOf(error) });
          this.setStatus(sessionId, 'idle');
        },
      );
  }

  /** Sessão com processo vivo (ACP ou terminal): a única em que o agente pode mandar arquivos (`POST /api/agent/files`). */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId) || this.terminals.has(sessionId);
  }

  verifyAgentToken(sessionId: string, token: string | undefined): boolean {
    return this.agentTokens.verify(sessionId, token);
  }

  /** Sink das imagens que o agente manda nesta sessão (ver AgentImages). */
  private imageSink(sessionId: string): ImageSink {
    return (block) => this.agentImages.store(sessionId, block);
  }

  /** Registra um arquivo que o agente mandou para o celular: evento `file` (direction to_phone) e aviso. */
  recordFileToPhone(sessionId: string, file: FileInfo, caption: string | undefined): SessionEvent | undefined {
    return this.appendEvent(sessionId, {
      kind: 'file',
      fileId: file.fileId,
      name: file.name,
      mime: file.mime,
      size: file.size,
      direction: 'to_phone',
      ...(caption !== undefined ? { caption } : {}),
    });
  }

  respondPermission(sessionId: string, requestId: string, optionId: string | null): void {
    this.requireAcp(sessionId);
    const live = this.requireLive(sessionId);
    const pending = live.pending;
    if (pending === undefined || pending.requestId !== requestId) {
      throw new SessionError('invalid_request', 'permissão não está pendente');
    }
    if (optionId !== null && !pending.optionIds.includes(optionId)) {
      throw new SessionError('invalid_request', 'opção de permissão inválida');
    }
    this.resolvePermission(live, optionId);
  }

  /** Notifica session/cancel e responde cancelled a uma permissão pendente. */
  cancel(sessionId: string): void {
    this.requireAcp(sessionId);
    const live = this.requireLive(sessionId);
    if (live.acpSessionId !== undefined) {
      live.connection.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: live.acpSessionId })
        .catch((error: unknown) => this.options.log.warn({ err: error, sessionId }, 'session/cancel falhou'));
    }
    this.resolvePermission(live, null);
  }

  async setConfig(sessionId: string, configId: string, value: ConfigValue): Promise<void> {
    this.requireAcp(sessionId);
    const live = this.requireLive(sessionId);
    await this.applyConfig(live, configId, value);
    this.broadcastSession(sessionId);
  }

  /** Bytes digitados no terminal (sessão pty viva). Terminal que já morreu vira error, sem derrubar nada. */
  terminalInput(sessionId: string, data: string): void {
    const terminal = this.requireTerminal(sessionId);
    try {
      terminal.process.write(data);
    } catch {
      throw new SessionError('session_busy', TERMINAL_GONE);
    }
  }

  terminalResize(sessionId: string, cols: number, rows: number): void {
    const terminal = this.requireTerminal(sessionId);
    try {
      terminal.process.resize(cols, rows);
    } catch {
      throw new SessionError('session_busy', TERMINAL_GONE);
    }
  }

  /** Para o processo e marca a sessão como stopped. Sessão sem processo só troca o status. */
  async stop(sessionId: string): Promise<void> {
    const terminal = this.terminals.get(sessionId);
    if (terminal !== undefined) {
      this.detachTerminal(terminal);
      this.setStatus(sessionId, 'stopped');
      terminal.process.kill();
      await withTimeout(terminal.exited, KILL_TIMEOUT_MS, 'encerrar terminal').catch(() => undefined);
      return;
    }

    const live = this.live.get(sessionId);
    if (live === undefined) {
      const session = this.load(sessionId);
      if (session.status !== 'stopped') this.setStatus(sessionId, 'stopped');
      return;
    }
    this.detach(live);
    this.setStatus(sessionId, 'stopped');
    killAgent(live.child);
    await withTimeout(live.exited, KILL_TIMEOUT_MS, 'encerrar agente').catch(() => undefined);
  }

  /**
   * Tira a sessão do app: linha, eventos e registros de arquivos. Não fala com o agente (o histórico dele continua).
   * Quem chama para o processo antes (`stop`) e remove o worktree, se pedido. Sessão com operação em curso → 409.
   */
  forget(sessionId: string): void {
    this.load(sessionId);
    if (this.live.has(sessionId) || this.terminals.has(sessionId) || this.reserved.has(sessionId)) {
      throw new SessionError('session_busy', 'sessão ainda está ativa: pare antes de remover');
    }
    this.listeners.delete(sessionId);
    this.agentImages.forget(sessionId);
    deleteSessionRows(this.options.db, sessionId);
  }

  /** Para as sessões informadas (ex.: workspace apagado). Ids sem processo só ficam como estão. */
  async stopSessions(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.stop(sessionId);
    }
  }

  /** Mata todos os agentes (inclusive os que falharam e ainda vivem) e espera saírem. Não grava nada no banco. */
  async shutdown(): Promise<void> {
    for (const live of [...this.live.values()]) this.detach(live);
    for (const terminal of [...this.terminals.values()]) this.detachTerminal(terminal);
    const processes = [...this.running];
    for (const proc of processes) proc.kill();
    await Promise.all(
      processes.map((proc) => withTimeout(proc.exited, KILL_TIMEOUT_MS, 'encerrar agente').catch(() => undefined)),
    );
  }

  /** Config de um agente configurado: `AgentConfig` ou erro de sessão (`unknown_agent`). */
  private agentOf(name: string): AgentConfig {
    // Object.hasOwn: "constructor" e afins herdam de Object e não são agentes configurados.
    const agent: AgentConfig | undefined = Object.hasOwn(this.options.config.agents, name)
      ? this.options.config.agents[name]
      : undefined;
    if (agent === undefined) throw new SessionError('unknown_agent', `agente desconhecido: ${name}`);
    return agent;
  }

  private requireFreeSlot(): void {
    if (countLiveSessions(this.options.db) + this.reserved.size >= MAX_LIVE_SESSIONS) {
      throw new SessionError('too_many_sessions', `limite de ${MAX_LIVE_SESSIONS} sessões vivas atingido`);
    }
  }

  /**
   * Linha de comando e env do processo do agente (ACP ou terminal). Emite o token da sessão: quem chama
   * revoga se o processo não subir.
   */
  private agentLaunch(id: string, agent: AgentConfig): { command: AgentCommand; env: NodeJS.ProcessEnv } {
    const token = this.agentTokens.issue(id);
    // Launchers do phone-send e node_modules/.bin vêm antes do PATH: `claude-agent-acp` roda sem instalação global.
    // As variáveis do daemon vêm depois do env do agente: o config não consegue sobrescrevê-las.
    const env = withPathPrepended(
      {
        ...process.env,
        ...agent.env,
        AGENT_SESSION_ID: id,
        NANACHI_URL: this.options.agentApiUrl(),
        NANACHI_AGENT_TOKEN: token,
      },
      [phoneSendBinDir(), ...agentBinDirs()],
    );
    return { command: resolveAgentCommand(agent.command, agent.args, env), env };
  }

  /** Sobe o processo do agente no cwd e registra a conexão. Lança se o executável não existe. */
  private spawnLive(id: string, cwd: string, agent: AgentConfig): LiveSession {
    const { log } = this.options;
    try {
      const { command, env } = this.agentLaunch(id, agent);
      const child = spawnAgent(command, {
        cwd,
        env,
        onDiagnostic: (line) => log.debug({ sessionId: id, agent: agent.label }, line),
      });
      return this.attach(id, child);
    } catch (error) {
      this.agentTokens.revoke(id);
      throw error;
    }
  }

  /** Sobe o terminal de uma sessão pty. Se não sobe, a sessão vai para error (como um agente ACP que não sobe). */
  private startTerminal(id: string, cwd: string, agent: AgentConfig): void {
    try {
      this.spawnTerminal(id, cwd, agent);
    } catch (error) {
      this.fail(id, messageOf(error));
      return;
    }
    this.setStatus(id, 'running');
  }

  /** PTY no cwd, 80x24, com o mesmo env dos agentes ACP. Lança se o processo não pode ser criado. */
  private spawnTerminal(id: string, cwd: string, agent: AgentConfig): LiveTerminal {
    try {
      const { command, env } = this.agentLaunch(id, agent);
      return this.attachTerminal(id, spawnPty(command, { cwd, env, cols: TERMINAL_COLS, rows: TERMINAL_ROWS }));
    } catch (error) {
      this.agentTokens.revoke(id);
      throw error;
    }
  }

  /** Registra o terminal vivo: saída agregada em `terminal_output`, e o fim vira `terminal_exit`. */
  private attachTerminal(id: string, pty: TerminalProcess): LiveTerminal {
    const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
    const proc: RunningProcess = { kill: () => pty.kill(), exited };
    this.running.add(proc);
    pty.onExit(() => this.running.delete(proc));

    const batcher = new OutputBatcher({
      onFlush: (data) => {
        // Depois de tirado do mapa (stop, shutdown), a saída que sobrou não é gravada.
        if (this.terminals.get(id) !== terminal) return;
        this.appendEvent(id, { kind: 'terminal_output', data });
        terminal.retainedBytes += Buffer.byteLength(data, 'utf8');
        const excess = terminal.retainedBytes - TERMINAL_RETENTION_BYTES;
        if (excess > 0) {
          terminal.retainedBytes -= dropOldestTerminalOutput(this.options.db, id, excess);
        }
      },
    });
    const terminal: LiveTerminal = { id, process: pty, batcher, exited, retainedBytes: 0 };
    this.terminals.set(id, terminal);
    pty.onData((chunk) => batcher.push(chunk));
    pty.onExit((exitCode) => this.onTerminalExit(terminal, exitCode));
    return terminal;
  }

  /** O processo do terminal saiu sozinho: descarrega a saída, grava `terminal_exit` e marca stopped. */
  private onTerminalExit(terminal: LiveTerminal, exitCode: number): void {
    if (this.terminals.get(terminal.id) !== terminal) return;
    terminal.batcher.end();
    this.appendEvent(terminal.id, { kind: 'terminal_exit', exitCode });
    this.detachTerminal(terminal);
    this.setStatus(terminal.id, 'stopped');
  }

  /** Tira o terminal do mapa e para de gravar a saída dele (o que ainda estava na janela é descartado). */
  private detachTerminal(terminal: LiveTerminal): void {
    this.terminals.delete(terminal.id);
    this.agentTokens.revoke(terminal.id);
    terminal.batcher.end();
  }

  /** Só sessão pty com terminal vivo: senão `not_pty` (sessão de agente) ou `session_busy` (terminal parado). */
  private requireTerminal(sessionId: string): LiveTerminal {
    if (this.load(sessionId).kind !== 'pty') throw new SessionError('not_pty', 'sessão de agente não tem terminal');
    const terminal = this.terminals.get(sessionId);
    if (terminal === undefined) throw new SessionError('session_busy', 'terminal não está ativo');
    return terminal;
  }

  /** Comandos ACP (prompt, config, permissão, cancel) não valem para sessão de terminal. */
  private requireAcp(sessionId: string): void {
    if (this.load(sessionId).kind === 'pty') {
      throw new SessionError('not_acp', 'sessão de terminal não aceita comandos ACP');
    }
  }

  private async start(id: string, cwd: string, agent: AgentConfig, requested: Record<string, ConfigValue>): Promise<void> {
    let live: LiveSession;
    try {
      live = this.spawnLive(id, cwd, agent);
    } catch (error) {
      this.fail(id, messageOf(error));
      return;
    }

    try {
      const { connection } = live;
      const initialized = await withTimeout(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        START_TIMEOUT_MS,
        'initialize',
      );
      live.promptImage = initialized.agentCapabilities?.promptCapabilities?.image === true;
      const created = await withTimeout(
        connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] }),
        START_TIMEOUT_MS,
        'session/new',
      );

      live.acpSessionId = created.sessionId;
      updateSession(this.options.db, id, { acpSessionId: created.sessionId }, Date.now());
      this.applyAgentConfig(live, created);
      this.persistConfig(live);
      live.phoneHintPending = true;

      await this.applyRequestedConfig(live, requested);

      if (this.isCurrent(live)) this.setStatus(id, 'idle');
    } catch (error) {
      if (this.isCurrent(live)) this.fail(id, messageOf(error));
    }
  }

  /** Aplica o config pedido na criação ou importação: opção desconhecida vai para o log; erro vira evento `error`. */
  private async applyRequestedConfig(live: LiveSession, requested: Record<string, ConfigValue>): Promise<void> {
    for (const [configId, value] of Object.entries(requested)) {
      if (!live.configOptions.some((option) => option.id === configId)) {
        this.options.log.debug({ sessionId: live.id, configId }, 'config ignorada: opção desconhecida para este agente');
        continue;
      }
      try {
        await this.applyConfig(live, configId, value);
      } catch (error) {
        this.appendEvent(live.id, { kind: 'error', message: `opção ${configId}: ${messageOf(error)}` });
      }
    }
  }

  /**
   * Retomada: a capacidade só é conhecida depois do initialize, então o status no banco fica como estava
   * até lá. Sem suporte, mata o processo e lança `not_resumable` (409). Depois disso: idle ou error.
   */
  private async restore(
    id: string,
    cwd: string,
    agent: AgentConfig,
    acpSessionId: string,
    savedOptions: SessionConfigOption[],
    markStarting: boolean,
  ): Promise<void> {
    let live: LiveSession;
    try {
      live = this.spawnLive(id, cwd, agent);
    } catch (error) {
      this.markFailed(id, messageOf(error));
      return;
    }
    live.acpSessionId = acpSessionId;
    live.configOptions = savedOptions;

    let method: RestoreMethod | undefined;
    try {
      const initialized = await withTimeout(
        live.connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        START_TIMEOUT_MS,
        'initialize',
      );
      method = restoreMethodOf(initialized.agentCapabilities);
      live.promptImage = initialized.agentCapabilities?.promptCapabilities?.image === true;
    } catch (error) {
      if (this.isCurrent(live)) this.fail(id, messageOf(error));
      return;
    }
    if (method === undefined) {
      this.detach(live);
      killAgent(live.child);
      throw new SessionError('not_resumable', 'agente não permite retomar sessões');
    }

    // Só depois de saber que o agente retoma: se não retoma, a sessão continua stopped sem eventos extras.
    if (markStarting) this.setStatus(id, 'starting');
    live.replaying = true;
    try {
      const params = { sessionId: acpSessionId, cwd, mcpServers: [] };
      const pending: Promise<acp.LoadSessionResponse | acp.ResumeSessionResponse> =
        method === 'load'
          ? live.connection.agent.request(acp.methods.agent.session.load, params)
          : live.connection.agent.request(acp.methods.agent.session.resume, params);
      const response = await withTimeout(pending, START_TIMEOUT_MS, method === 'load' ? 'session/load' : 'session/resume');
      if (!this.isCurrent(live)) return;
      live.replaying = false;
      this.applyAgentConfig(live, response);
      this.persistConfig(live);
      this.setStatus(id, 'idle');
    } catch (error) {
      if (this.isCurrent(live)) this.fail(id, messageOf(error));
    }
  }

  /** Opções que o agente anunciou na abertura/retomada substituem as salvas; sem elas, mantém as salvas. */
  private applyAgentConfig(
    live: LiveSession,
    response: { configOptions?: readonly acp.SessionConfigOption[] | null; modes?: acp.SessionModeState | null },
  ): void {
    if (response.configOptions) {
      live.configOptions = flattenConfigOptions(response.configOptions);
      live.usesSetMode = false;
    } else if (response.modes) {
      const mode = modeConfigOption(response.modes);
      if (mode !== undefined) {
        live.configOptions = [mode];
        live.usesSetMode = true;
      }
    }
  }

  /** Cria a conexão ACP sobre o processo e registra a sessão como viva. */
  private attach(id: string, child: AgentChild): LiveSession {
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    const proc: RunningProcess = { kill: () => killAgent(child), exited };
    this.running.add(proc);
    // 'error' sem 'exit' acontece quando o executável nem sobe (ENOENT): também não há processo para esperar.
    const forget = (): void => {
      this.running.delete(proc);
    };
    child.once('exit', forget);
    child.once('error', forget);
    const connection = connectAcp(child, {
      onSessionUpdate: (notification) => this.handleUpdate(id, notification),
      onPermissionRequest: (request, signal) => this.requestPermission(id, request, signal),
    });
    const live: LiveSession = {
      id,
      child,
      connection,
      exited,
      acpSessionId: undefined,
      configOptions: [],
      usesSetMode: false,
      status: 'starting',
      promptInFlight: false,
      pending: undefined,
      replaying: false,
      promptImage: false,
      history: undefined,
      phoneHintPending: false,
    };
    this.live.set(id, live);

    child.once('exit', (code, signal) =>
      this.failIfCurrent(live, `agente encerrou inesperadamente (${exitReason(code, signal)})`),
    );
    child.once('error', (error) => this.failIfCurrent(live, `erro ao executar o agente: ${error.message}`));
    void connection.closed.then(() => this.failIfCurrent(live, 'conexão com o agente encerrada'));
    return live;
  }

  private handleUpdate(id: string, notification: acp.SessionNotification): void {
    const live = this.live.get(id);
    if (live === undefined) return;
    const update = notification.update;
    // Comandos não são histórico: valem também durante o replay do session/load.
    if (update.sessionUpdate === 'available_commands_update') {
      this.setCommands(id, availableCommandsOf(update));
      return;
    }
    // Replay do session/load: a retomada normal descarta (o banco já tem o histórico); a importação grava.
    if (live.replaying) {
      if (live.history !== undefined) this.recordHistory(live, update);
      return;
    }

    switch (update.sessionUpdate) {
      case 'config_option_update':
        live.configOptions = flattenConfigOptions(update.configOptions);
        this.persistConfig(live);
        this.broadcastSession(id);
        return;
      case 'current_mode_update': {
        const modeId = update.currentModeId;
        live.configOptions = live.configOptions.map((option) =>
          option.category === 'mode' && option.type === 'select' ? { ...option, currentValue: modeId } : option,
        );
        this.persistConfig(live);
        this.broadcastSession(id);
        return;
      }
      default: {
        const draft = sessionUpdateToDraft(update, this.imageSink(id));
        if (draft === undefined) {
          this.options.log.debug({ sessionId: id, update: update.sessionUpdate }, 'session/update ignorado');
          return;
        }
        // Imagem do agente não avisa push: só o phone-send explícito avisa.
        this.appendEvent(id, draft, { notify: draft.kind !== 'file' });
      }
    }
  }

  /**
   * Lista mais recente de comandos do agente: gravada na sessão (também quando ela parar). Lista igual à gravada
   * não faz nada; uma diferente vai só para quem está inscrito na sessão.
   */
  private setCommands(id: string, commands: AvailableCommand[]): void {
    if (isDeepStrictEqual(findSessionCommands(this.options.db, id), commands)) return;
    updateSession(this.options.db, id, { commands }, Date.now());
    this.broadcastSession(id);
    this.emitCommands(id, commands);
  }

  /**
   * Importa uma sessão criada fora do app (id listado em `agent-sessions`). Diferente da retomada, o histórico
   * reenviado pelo session/load é gravado: é a única cópia que o app terá. Já ligada a uma sessão do app →
   * 409 com o id dela (`already_running` se está aberta, `already_linked` se parada). Falha depois de criada
   * vira status `error`, como em create().
   */
  private async importSession(input: ImportSessionInput): Promise<Session> {
    const { db } = this.options;
    const workspace = findWorkspaceById(db, input.workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    const agent = this.agentOf(input.agent);
    if (input.worktree === true) throw new SessionError('invalid_request', 'sessão importada não usa worktree');
    if (agent.kind === 'pty') throw new SessionError('not_resumable', 'terminal não lista sessões do agente');

    const link = findAcpLinks(db, input.agent).get(input.resumeAcpSessionId);
    if (link !== undefined) {
      const open = !TERMINAL_STATUSES.includes(link.status);
      throw new SessionError(
        open ? 'already_running' : 'already_linked',
        open ? 'sessão já está aberta no app' : 'sessão já está no app (parada): abra e retome',
        { sessionId: link.sessionId },
      );
    }
    this.requireFreeSlot();

    const id = randomUUID();
    const now = Date.now();
    // Sem await entre a checagem da ligação e este insert: duas importações da mesma sessão não passam juntas.
    insertSession(db, {
      id,
      workspaceId: workspace.id,
      agent: input.agent,
      kind: 'acp',
      title: input.resumeTitle ?? RESUMED_TITLE,
      status: 'starting',
      createdAt: now,
    });
    updateSession(db, id, { acpSessionId: input.resumeAcpSessionId }, now);
    this.announceStatus(id, 'starting');

    await this.importAcp(id, workspace.path, agent, input.resumeAcpSessionId, input.config ?? {});
    return this.load(id);
  }

  /** Sobe o agente, negocia session/load (ou session/resume) gravando o replay, aplica o config e fica idle. */
  private async importAcp(
    id: string,
    cwd: string,
    agent: AgentConfig,
    acpSessionId: string,
    requested: Record<string, ConfigValue>,
  ): Promise<void> {
    let live: LiveSession;
    try {
      live = this.spawnLive(id, cwd, agent);
    } catch (error) {
      this.markFailed(id, messageOf(error));
      return;
    }
    live.acpSessionId = acpSessionId;

    let method: RestoreMethod | undefined;
    try {
      const initialized = await withTimeout(
        live.connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        START_TIMEOUT_MS,
        'initialize',
      );
      method = restoreMethodOf(initialized.agentCapabilities);
      live.promptImage = initialized.agentCapabilities?.promptCapabilities?.image === true;
    } catch (error) {
      if (this.isCurrent(live)) this.fail(id, messageOf(error));
      return;
    }
    if (method === undefined) {
      if (this.isCurrent(live)) this.fail(id, 'agente não permite retomar sessões');
      return;
    }

    live.history = { recorded: 0, truncated: false, pendingUser: undefined };
    live.replaying = true;
    try {
      const params = { sessionId: acpSessionId, cwd, mcpServers: [] };
      const pending: Promise<acp.LoadSessionResponse | acp.ResumeSessionResponse> =
        method === 'load'
          ? live.connection.agent.request(acp.methods.agent.session.load, params)
          : live.connection.agent.request(acp.methods.agent.session.resume, params);
      const response = await withTimeout(pending, START_TIMEOUT_MS, method === 'load' ? 'session/load' : 'session/resume');
      if (!this.isCurrent(live)) return;
      this.flushPendingUser(live);
      live.replaying = false;
      live.history = undefined;
      this.applyAgentConfig(live, response);
      this.persistConfig(live);
      await this.applyRequestedConfig(live, requested);
      if (this.isCurrent(live)) this.setStatus(id, 'idle');
    } catch (error) {
      if (this.isCurrent(live)) this.fail(id, messageOf(error));
    }
  }

  /** Grava um update do replay. Mensagem do usuário em chunks seguidos vira um user_message só. */
  private recordHistory(live: LiveSession, update: acp.SessionUpdate): void {
    if (update.sessionUpdate === 'user_message_chunk') {
      const history = live.history;
      if (history !== undefined && update.content.type === 'text') {
        history.pendingUser = (history.pendingUser ?? '') + update.content.text;
      }
      return;
    }
    this.flushPendingUser(live);
    const draft = sessionUpdateToDraft(update, this.imageSink(live.id));
    if (draft !== undefined) this.recordHistoryEvent(live, draft);
  }

  private flushPendingUser(live: LiveSession): void {
    const history = live.history;
    if (history === undefined || history.pendingUser === undefined) return;
    const text = history.pendingUser;
    history.pendingUser = undefined;
    if (text.length > 0) this.recordHistoryEvent(live, { kind: 'user_message', text });
  }

  /**
   * Grava até IMPORT_HISTORY_LIMIT eventos; no primeiro que sobra, grava o aviso de truncado e descarta o resto.
   * Nada disso avisa `onNotify`: é histórico antigo, não um acontecimento novo.
   */
  private recordHistoryEvent(live: LiveSession, draft: EventDraft): void {
    const history = live.history;
    if (history === undefined) return;
    if (history.recorded >= IMPORT_HISTORY_LIMIT) {
      if (!history.truncated) {
        history.truncated = true;
        this.appendEvent(
          live.id,
          { kind: 'error', message: `histórico truncado: só os primeiros ${IMPORT_HISTORY_LIMIT} eventos foram importados` },
          { notify: false },
        );
      }
      return;
    }
    history.recorded += 1;
    this.appendEvent(live.id, draft, { notify: false });
  }

  /**
   * Sessões que o agente tem para a pasta do workspace (`session/list`). Não grava nada e não ocupa vaga:
   * sobe um processo só para isto. Agente de terminal ou sem `sessionCapabilities.list` → `supported: false`.
   */
  async listAgentSessions(
    workspaceId: string,
    agentName: string,
    cursor: string | undefined,
  ): Promise<AgentSessionsResponse> {
    const { db } = this.options;
    const workspace = findWorkspaceById(db, workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    const agent = this.agentOf(agentName);
    if (agent.kind === 'pty') return { supported: false, sessions: [], nextCursor: null };
    if (this.listing.has(agentName)) throw new SessionError('busy', 'já há uma listagem em andamento para este agente');

    this.listing.add(agentName);
    try {
      const page = await this.probeAgent(agent, workspace.path, this.agentListTimeoutMs, async (connection) => {
        const initialized = await connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        if (!initialized.agentCapabilities?.sessionCapabilities?.list) return undefined;
        return this.collectPages(connection, workspace.path, cursor);
      });
      if (page === undefined) return { supported: false, sessions: [], nextCursor: null };

      const links = findAcpLinks(db, agentName);
      const sessions = page.sessions
        .map((info) => ({
          acpSessionId: info.sessionId,
          title: info.title ? info.title : null,
          updatedAt: listedUpdatedAt(info.updatedAt),
          linkedSessionId: links.get(info.sessionId)?.sessionId ?? null,
        }))
        .sort(newestFirst);
      return { supported: true, sessions, nextCursor: page.nextCursor };
    } finally {
      this.listing.delete(agentName);
    }
  }

  /**
   * Lê páginas do session/list a partir do cursor até achar sessões da pasta (no máximo LIST_MAX_PAGES páginas).
   * Devolve o cursor da próxima página não lida, ou null se acabou.
   */
  private async collectPages(
    connection: acp.ClientConnection,
    cwd: string,
    cursor: string | undefined,
  ): Promise<{ sessions: acp.SessionInfo[]; nextCursor: string | null }> {
    let next = cursor;
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const response = await connection.agent.request(acp.methods.agent.session.list, {
        cwd,
        ...(next !== undefined ? { cursor: next } : {}),
      });
      const matching = response.sessions.filter((info) => sameWorkingDirectory(info.cwd, cwd));
      next = response.nextCursor ?? undefined;
      if (matching.length > 0 || next === undefined) return { sessions: matching, nextCursor: next ?? null };
    }
    return { sessions: [], nextCursor: next ?? null };
  }

  /**
   * Processo ACP temporário, só para consultar o agente: sobe, roda `run` e mata (também se `run` falhar).
   * Não toca no mapa de sessões. Estoura em `agent_timeout` (504); sai antes de responder → `agent_failed` (502).
   * Entra em `running`, então o shutdown do daemon também o alcança.
   */
  private async probeAgent<T>(
    agent: AgentConfig,
    cwd: string,
    timeoutMs: number,
    run: (connection: acp.ClientConnection) => Promise<T>,
  ): Promise<T> {
    const id = randomUUID();
    let child: AgentChild;
    try {
      const { command, env } = this.agentLaunch(id, agent);
      child = spawnAgent(command, {
        cwd,
        env,
        onDiagnostic: (line) => this.options.log.debug({ agent: agent.label }, line),
      });
    } catch (error) {
      this.agentTokens.revoke(id);
      throw new SessionError('agent_failed', `agente não subiu: ${messageOf(error)}`);
    }

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });
    const proc: RunningProcess = { kill: () => killAgent(child), exited };
    this.running.add(proc);
    const forget = (): void => {
      this.running.delete(proc);
    };
    child.once('exit', forget);
    child.once('error', forget);

    const connection = connectAcp(child, {
      onSessionUpdate: () => undefined,
      onPermissionRequest: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SessionError('agent_timeout', `agente não respondeu em ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    const died = exited.then(() => {
      throw new SessionError('agent_failed', 'agente encerrou antes de responder');
    });
    try {
      return await Promise.race([run(connection), timeout, died]);
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError('agent_failed', messageOf(error));
    } finally {
      clearTimeout(timer);
      this.agentTokens.revoke(id);
      killAgent(child);
      await withTimeout(exited, KILL_TIMEOUT_MS, 'encerrar agente').catch(() => undefined);
    }
  }

  /** Grava o cartão de permissão e fica pendente até respondermos (WS) ou a requisição ser abortada. */
  private requestPermission(
    id: string,
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    const live = this.live.get(id);
    if (live === undefined) return Promise.resolve(cancelled);

    // Um agente que pede outra permissão antes de responder a anterior não pode deixar a anterior pendurada.
    this.resolvePermission(live, null);
    const requestId = randomUUID();
    const { toolCall } = request;
    const recorded = this.appendEvent(id, {
      kind: 'permission_request',
      requestId,
      title: toolCall.title ?? '',
      ...(toolCall.kind ? { toolKind: toolCall.kind } : {}),
      ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
      content: toolContentOf(toolCall.content, this.imageSink(id)),
      options: request.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
    });
    if (recorded === undefined) return Promise.resolve(cancelled);

    const decision = new Promise<string | null>((resolve) => {
      live.pending = { requestId, optionIds: request.options.map((option) => option.optionId), resolve };
    });
    this.setStatus(id, 'awaiting_permission');
    signal.addEventListener(
      'abort',
      () => {
        if (live.pending?.requestId === requestId) this.resolvePermission(live, null);
      },
      { once: true },
    );

    return decision.then((optionId) =>
      optionId === null
        ? cancelled
        : { outcome: { outcome: 'selected', optionId } },
    );
  }

  private resolvePermission(live: LiveSession, optionId: string | null): void {
    const pending = live.pending;
    if (pending === undefined) return;
    live.pending = undefined;
    pending.resolve(optionId);
    this.appendEvent(live.id, { kind: 'permission_resolved', requestId: pending.requestId, optionId });
    this.setStatus(live.id, live.promptInFlight ? 'running' : 'idle');
  }

  private async applyConfig(live: LiveSession, configId: string, value: ConfigValue): Promise<void> {
    const option = live.configOptions.find((item) => item.id === configId);
    if (option === undefined) throw new SessionError('invalid_request', `opção desconhecida: ${configId}`);
    const sessionId = live.acpSessionId;
    if (sessionId === undefined) throw new SessionError('session_busy', 'agente ainda não abriu a sessão');

    if (live.usesSetMode && configId === MODE_OPTION_ID) {
      if (typeof value !== 'string') throw new SessionError('invalid_request', 'valor de modo deve ser texto');
      await live.connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: value });
      live.configOptions = live.configOptions.map((item) =>
        item.id === configId && item.type === 'select' ? { ...item, currentValue: value } : item,
      );
    } else if (option.type === 'boolean') {
      if (typeof value !== 'boolean') throw new SessionError('invalid_request', 'valor deve ser booleano');
      const response = await live.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        type: 'boolean',
        value,
      });
      live.configOptions = flattenConfigOptions(response.configOptions);
    } else {
      if (typeof value !== 'string') throw new SessionError('invalid_request', 'valor deve ser texto');
      const response = await live.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId,
        value,
      });
      live.configOptions = flattenConfigOptions(response.configOptions);
    }
    this.persistConfig(live);
  }

  private persistConfig(live: LiveSession): void {
    updateSession(this.options.db, live.id, { configOptions: live.configOptions }, Date.now());
  }

  /**
   * Grava o evento (validado antes; inválido vira log e é descartado). Devolve o evento com seq.
   * `notify: false` grava sem avisar `onNotify` (usado no replay da importação: histórico antigo não é notícia).
   */
  private appendEvent(
    sessionId: string,
    draft: EventDraft,
    options: { notify?: boolean } = {},
  ): SessionEvent | undefined {
    const { db, log } = this.options;
    const ts = Date.now();
    const kind = draft.kind;
    const check = SessionEventSchema.safeParse({ ...draft, seq: 1, sessionId, ts });
    if (!check.success) {
      log.warn({ sessionId, kind, issues: check.error.issues }, 'evento descartado: fora do schema');
      return undefined;
    }

    const seq = insertEvent(db, { sessionId, ts, kind, payload: JSON.stringify(draft) });
    const event = SessionEventSchema.parse({ ...draft, seq, sessionId, ts });
    this.emit(sessionId, event);
    if (options.notify !== false) this.notify(sessionId, event);
    return event;
  }

  /** Avisa quem escuta (`onNotify`). Erro do handler vai para o log e não quebra o evento. */
  private notify(sessionId: string, event: SessionEvent): void {
    const notice = notifyOf(event);
    if (notice === undefined) return;
    try {
      this.options.onNotify?.(sessionId, notice.kind, notice.details);
    } catch (error) {
      this.options.log.warn({ err: error, sessionId }, 'aviso falhou');
    }
  }

  /** Anexos pedidos no prompt: têm de ser do celular e desta sessão; qualquer outro id é erro (400). */
  private attachmentRecords(sessionId: string, ids: readonly string[]): FileRecord[] {
    return ids.map((id) => {
      const record = findFileById(this.options.db, id);
      if (record === undefined || record.sessionId !== sessionId || record.direction !== 'from_phone') {
        throw new SessionError('invalid_request', 'anexo inválido para esta sessão');
      }
      return record;
    });
  }

  /** Imagem vai inline só se o agente anunciou `promptCapabilities.image`; o resto vai como caminho. */
  private async loadAttachments(live: LiveSession, records: readonly FileRecord[]): Promise<PromptAttachment[]> {
    return Promise.all(
      records.map(async (record): Promise<PromptAttachment> => {
        const base = { path: record.path, mime: record.mime };
        if (!live.promptImage || !isPromptImage(record.mime)) return base;
        try {
          return { ...base, imageData: (await readFile(record.path)).toString('base64') };
        } catch {
          throw new SessionError('invalid_request', `anexo não está mais no disco: ${record.name}`);
        }
      }),
    );
  }

  private emit(sessionId: string, event: SessionEvent): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener.event(event);
      } catch (error) {
        this.options.log.warn({ err: error, sessionId }, 'assinante de evento falhou');
      }
    }
  }

  private emitCommands(sessionId: string, commands: AvailableCommand[]): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener.commands(commands);
      } catch (error) {
        this.options.log.warn({ err: error, sessionId }, 'assinante de comandos falhou');
      }
    }
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    updateSession(this.options.db, sessionId, { status }, Date.now());
    const live = this.live.get(sessionId);
    if (live !== undefined) live.status = status;
    this.announceStatus(sessionId, status);
  }

  private announceStatus(sessionId: string, status: SessionStatus): void {
    this.appendEvent(sessionId, { kind: 'status', status });
    this.broadcastSession(sessionId);
  }

  /**
   * Falha terminal: tira do mapa, grava erro, marca `error` e mata o processo. Com processo registrado, sempre
   * vale (inclusive numa retomada, que parte de `stopped`). Sem processo, só se a sessão não estava parada/erro.
   */
  private fail(sessionId: string, message: string): void {
    const live = this.live.get(sessionId);
    if (live !== undefined) {
      this.detach(live);
    } else if (TERMINAL_STATUSES.includes(this.load(sessionId).status)) {
      return;
    }
    this.markFailed(sessionId, message, live);
  }

  private markFailed(sessionId: string, message: string, live?: LiveSession): void {
    this.appendEvent(sessionId, { kind: 'error', message });
    this.setStatus(sessionId, 'error');
    if (live !== undefined) killAgent(live.child);
  }

  private failIfCurrent(live: LiveSession, message: string): void {
    if (this.isCurrent(live)) this.fail(live.id, message);
  }

  /** Tira a sessão do mapa e libera quem espera permissão (sem resposta ao agente: a conexão já vai embora). */
  private detach(live: LiveSession): void {
    this.live.delete(live.id);
    this.agentTokens.revoke(live.id);
    const pending = live.pending;
    live.pending = undefined;
    pending?.resolve(null);
  }

  private isCurrent(live: LiveSession): boolean {
    return this.live.get(live.id) === live;
  }

  private requireLive(sessionId: string): LiveSession {
    const live = this.live.get(sessionId);
    if (live !== undefined) return live;
    this.load(sessionId);
    throw new SessionError('session_busy', 'sessão não está ativa');
  }

  private load(sessionId: string): Session {
    const session = findSessionById(this.options.db, sessionId);
    if (session === undefined) throw new SessionError('not_found', 'sessão não encontrada');
    return session;
  }

  private broadcastSession(sessionId: string): void {
    const session = findSessionById(this.options.db, sessionId);
    if (session !== undefined) this.options.broadcast({ type: 'session', session });
  }
}
