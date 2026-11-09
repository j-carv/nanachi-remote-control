/// <reference lib="es2024.promise" />
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import {
  MAX_QUEUED_PROMPTS,
  SHELL_AGENT_ID,
  SessionEventSchema,
  type AgentConfig,
  type AgentSessionsResponse,
  type AvailableCommand,
  type AskUserRequest,
  type AskUserResult,
  type ConfigValue,
  type CreateSessionRequest,
  type FileInfo,
  type Loop,
  type LearningNotice,
  type LoopRequest,
  type QueuedPrompt,
  type ResetRedeemResponse,
  type ResetsResponse,
  type PreviewCloseReason,
  type PreviewInfo,
  type RequestFileAgentResult,
  type RequestFileRequest,
  type RequestFileResult,
  type ScheduleModelsResponse,
  type ScheduleRun,
  type ServerMessage,
  type Session,
  type SessionConfigOption,
  type SessionEvent,
  type SessionStatus,
  type UsageResponse,
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
import { isModeAllowed, offeredConfigOptions } from './agent-modes.js';
import { yoloApproval } from './yolo.js';
import type { ToolCallMemory } from './tool-background.js';
import { AccountSelectionError, type AccountLauncher } from './accounts/launch.js';
import { mergeEnv } from './agent-env.js';
import { AgentImages } from './agent-images.js';
import { agentBinDirs, phoneSendBinDir, withPathPrepended } from './agent-path.js';
import { USAGE_CACHE_MS, USAGE_CANCEL_GRACE_MS, USAGE_IDLE_MS, USAGE_TIMEOUT_MS, usageCommandOf, usageTimeoutOf } from './agent-usage.js';
import { AgentTokens } from './agent-tokens.js';
import { nanachiMcpDescriptor } from './nanachi-mcp.js';
import { resolveAgentCommand, type AgentCommand } from './agent-command.js';
import { PathError, resolveInsideRoots } from './roots.js';
import { chooseShell, localShells, shellEnvironment, type ShellOption } from './shells.js';
import { connectAcp, killAgent, spawnAgent, type AcpHandlers, type AcpProcess, type AgentChild } from './agent-process.js';
import type { LoadedConfig } from './config.js';
import { toFileInfo } from './files.js';
import { addWorktree, deleteMergedBranch, hasCommits, isGitRepo, isWorktreeDirty, pruneWorktrees, removeWorktree } from './git.js';
import { LOOP_SELF_PACE_INSTRUCTION, LoopBusyError, LoopError, LoopRunner, type LoopTurn } from './loop-runner.js';
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
  findSessionConfigOptions,
  findWorkspaceById,
  insertEvent,
  insertSession,
  updateSession,
  type FileRecord,
  type Worktree,
} from './repository.js';
import { OutputBatcher, TERMINAL_RETENTION_BYTES } from './terminal-output.js';
import { UsageProbe, UsageProbeError } from './usage-probe.js';
import { ResetError, ResetService, type ResetTarget } from './reset-service.js';
import { resetSourceOf } from './usage-resets.js';
import { UserQuestions } from './user-questions.js';
import { FileRequests } from './file-requests.js';
import type { LearningTurnSource } from './learning-service.js';

export const DEFAULT_TITLE = 'Nova sessão';

/** Erro de reset vira SessionError (o HTTP responde o código); qualquer outro erro segue como bug. */
function sessionErrorOf(error: unknown): unknown {
  if (error instanceof ResetError) return new SessionError(error.code, error.message);
  return error;
}
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
/** Status em que o agente está trabalhando: a conta da sessão não troca nesses (o processo ainda usa a pasta dela). */
const ACCOUNT_BUSY_STATUSES: readonly SessionStatus[] = ['starting', 'running', 'awaiting_permission'];
/**
 * The account a process, a resume or a start that is still being reserved belongs to. `accountId` null is the principal.
 * `isAccountInUse` reads these: the sessions table alone does not know about a resume that has not written `starting`.
 */
interface AccountClaim {
  agent: string;
  accountId: string | null;
}

/** Account of a process about to start: the claim, and the env that points the agent at the account folder. */
interface AccountLaunch {
  claim: AccountClaim;
  env: NodeJS.ProcessEnv;
}

/** Erro do prompt numa sessão que não pode ser retomada (PTY, sem acp_session_id, agente sem loadSession/resume). */
const NOT_RESUMABLE_PROMPT_MESSAGE = 'sessão encerrada e não pode ser retomada; crie uma nova';

export interface ResumeOptions {
  /** Grava `starting` enquanto o agente carrega a sessão (reload e prompt; o Retomar manual não grava). */
  markStarting?: boolean;
}

/** Resultado de uma retomada: a sessão como ficou e, se o agente subiu e falhou, a mensagem da falha. */
interface ResumeOutcome {
  session: Session;
  failure: string | undefined;
}
/** Título de sessão importada quando o cliente não manda o da listagem. */
export const RESUMED_TITLE = 'Sessão retomada';
/** Eventos do histórico reenviado que a importação grava; o resto é descartado com um aviso `error`. */
export const IMPORT_HISTORY_LIMIT = 5_000;
/** Tempo total de uma listagem (`agent-sessions`): sobe o agente, negocia e lê as páginas. */
const LIST_TIMEOUT_MS = 30_000;
/** Páginas do session/list lidas por pedido. Páginas vazias do filtro de pasta contam. */
const LIST_MAX_PAGES = 5;

export type SessionErrorCode =
  | 'prompt_queue_full'
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
  | 'worktree_dirty'
  | 'session_not_active'
  | 'usage_unsupported'
  | 'resets_unsupported'
  | 'reset_in_progress'
  | 'accounts_unsupported'
  | 'loop_not_found'
  | 'loop_finished'
  | 'loop_busy'
  | 'shell_disabled'
  | 'shell_unavailable'
  | 'outside_roots';

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

/**
 * Quem assina uma sessão recebe os eventos (histórico e ao vivo), cada lista nova de comandos e cada mudança de
 * opções de configuração.
 */
export interface SessionListener {
  event(event: SessionEvent): void;
  commands(commands: AvailableCommand[]): void;
  configOptions(configOptions: SessionConfigOption[]): void;
  promptQueue(queue: QueuedPrompt[]): void;
  /** Loop da sessão mudou (null = sem loop). Ver PLAN.md, modo Loop. */
  loop(loop: Loop | null): void;
}

export interface SessionManagerOptions {
  db: Database.Database;
  config: LoadedConfig;
  log: FastifyBaseLogger;
  /** Manda uma mensagem a todos os clientes WS autenticados. */
  broadcast(message: ServerMessage): void;
  /** Base HTTP que o agente usa para falar com o daemon (`NANACHI_URL`, ex.: http://127.0.0.1:7777). */
  agentApiUrl(): string;
  /** Opt-in for the selected ACP agent, sampled only when its session process opens. Absent means disabled. */
  nanachiMcpEnabled?: ((agentId: string) => boolean) | undefined;
  /** Attention notices, including explicit questions, file requests and preview cards. */
  onNotify?: NotifyHandler | undefined;
  /** `<NANACHI_HOME>/worktrees`: cada worktree vai em `<raiz>/<workspaceId>/<8 chars do id da sessão>`. */
  worktreesRoot: string;
  /** `<NANACHI_HOME>/files`, absoluto: onde ficam as imagens que o agente manda. */
  filesRoot: string;
  /** Teto da listagem de sessões do agente. Padrão: 30 s. Testes usam valor curto. */
  agentListTimeoutMs?: number | undefined;
  /** Teto da leitura de uso (`usage`). Padrão: 30 s. Testes usam valor curto. */
  usageTimeoutMs?: number | undefined;
  /** Cache da leitura de uso. Padrão: 30 s. Testes usam 0 (sem cache) ou valor curto. */
  usageCacheMs?: number | undefined;
  /** Ociosidade até o processo de uso morrer. Padrão: 2 min. Testes usam valor curto. */
  usageIdleMs?: number | undefined;
  /** Question deadline. Defaults to the shared five-minute MCP timeout; tests can use a short deadline. */
  askUserTimeoutMs?: number | undefined;
  /** File request deadline. Defaults to five minutes; tests can use a short deadline. */
  requestFileTimeoutMs?: number | undefined;
  /** Revoke session-owned ephemeral resources after pending requests are cancelled and the process detaches. */
  onSessionDetached?: ((sessionId: string) => void) | undefined;
  /** Successful real turns only, after their streamed events and turn_end have been persisted and broadcast. */
  onTurnCompleted?: ((sessionId: string, sourceTurnSeq: number) => void) | undefined;
  /** Cancels background reviews before source cancellation, including a source that currently has no process. */
  onSessionRevoked?: ((sessionId: string) => void) | undefined;
  /** `<NANACHI_HOME>/usage-probe`: pasta de trabalho dos processos de uso, fora dos projetos. */
  usageProbeRoot: string;
  /** Versão do daemon (clientInfo do app-server do codex, resets). */
  appVersion: string;
  /** Contas dos agentes: qual conta cada sessão usa, o preparo da pasta do perfil e o env que aponta para ela. */
  accounts: AccountLauncher;
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
  /** Tool call que pede a permissão: um novo pedido do mesmo tool call enquanto esta espera não avisa de novo. */
  toolCallId: string;
  optionIds: readonly string[];
  resolve(optionId: string | null): void;
}

/** Estado em memória de uma sessão com processo vivo. O banco é a fonte para o resto. */
interface PendingPrompt {
  id: string;
  text: string;
  attachmentIds: readonly string[];
  failed: boolean;
}

interface LiveSession {
  readonly id: string;
  /** The agent this process runs (the session's `agent`). Picks the modes Nanachi offers (agent-modes.ts). */
  readonly agentId: string;
  readonly child: AgentChild;
  readonly connection: acp.ClientConnection;
  /** Resolve quando o processo sai (ou falha ao subir). Usado para esperar o kill. */
  readonly exited: Promise<void>;
  /** The account folder this process was started on. */
  readonly claim: AccountClaim;
  acpSessionId: string | undefined;
  configOptions: SessionConfigOption[];
  /** Exact account and advertised model captured before the foreground turn starts. */
  turnSource: LearningTurnSource | undefined;
  /** Agente anunciou só `modes`: a opção "mode" foi sintetizada e troca por session/set_mode. */
  usesSetMode: boolean;
  status: SessionStatus;
  promptInFlight: boolean;
  cancelRequested: boolean;
  promptQueue: PendingPrompt[];
  drainingPromptQueue: boolean;
  yolo: boolean;
  pending: PendingPermission | undefined;
  /** Entre session/load e a resposta dele: os updates reenviados são descartados (o banco já tem o histórico). */
  replaying: boolean;
  /** `promptCapabilities.image` do initialize: imagens de anexo vão inline no prompt. */
  promptImage: boolean;
  /** O agente sabe retomar sessão (load ou resume), conhecido depois do initialize. Sem isso a conta não troca com o processo vivo. */
  restorable: boolean | undefined;
  /** Só na importação: o replay do load vira eventos em vez de ser descartado. */
  history: HistoryRecord | undefined;
  /** MCP definitions and credentials are fixed for this process and refreshed by the normal restart path. */
  readonly mcpServers: acp.McpServer[];
  /** Tool calls com background já vistos nesta sessão (PLAN.md, subagentes e segundo plano). Some ao recarregar o daemon. */
  toolCalls: ToolCallMemory;
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

/** Bounds startup/profile work without allowing a cancelled continuation to launch a process later. */
function scheduledWait<T>(promise: Promise<T>, signal: AbortSignal, ms = START_TIMEOUT_MS): Promise<T> {
  signal.throwIfAborted();
  const interrupted = Promise.withResolvers<never>();
  const abort = (): void => interrupted.reject(signal.reason ?? new Error('schedule cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => interrupted.reject(new SessionError('agent_timeout', 'scheduled agent startup timed out')), ms);
  return Promise.race([promise, interrupted.promise]).finally(() => {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  });
}

/** Chave dos resets de uma conta extra do codex (cache e resgate em curso): `<agente>:<conta>`. */
function resetKeyOf(agentId: string, accountId: string): string {
  return `${agentId}:${accountId}`;
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
  private readonly reserved = new Map<string, AccountClaim | undefined>();
  /** Scheduled rows occupy a live slot, while profile preparation still needs an account claim. */
  private readonly scheduledClaims = new Map<string, AccountClaim>();
  private readonly scheduledProcesses = new Map<string, LiveSession>();
  /** Retomadas em curso, por sessão: quem chega enquanto uma roda espera a mesma (ver resumeOnce). */
  private readonly resumes = new Map<string, Promise<ResumeOutcome>>();
  /** Sessões no meio de uma troca de conta (parar o agente e retomar): outra troca espera. A conta de antes e a de depois. */
  private readonly switching = new Map<string, readonly AccountClaim[]>();
  /** Excludes resumes and account changes while owned attachments and history are removed. */
  private readonly forgetting = new Set<string>();
  private readonly agentTokens = new AgentTokens();
  /** Agentes com uma listagem em andamento (no máximo uma por agente). */
  private readonly listing = new Set<string>();
  private readonly agentListTimeoutMs: number;
  private readonly usageProbe: UsageProbe;
  private readonly resets: ResetService;
  private readonly agentImages: AgentImages;
  private readonly loops: LoopRunner;
  private readonly userQuestions: UserQuestions;
  private readonly fileRequests: FileRequests;

  constructor(private readonly options: SessionManagerOptions) {
    this.agentListTimeoutMs = options.agentListTimeoutMs ?? LIST_TIMEOUT_MS;
    this.loops = new LoopRunner(options.db, {
      statusOf: (sessionId) => findSessionById(options.db, sessionId)?.status,
      send: async (sessionId, text, turn) => {
        try {
          await this.prompt(sessionId, text, [], turn);
        } catch (error) {
          // Ocupada antes do envio: o loop espera, sem contar a iteração nem pausar.
          if (error instanceof SessionError && error.code === 'session_busy') throw new LoopBusyError(error.message);
          throw error;
        }
      },
      changed: (sessionId, loop) => this.emitLoop(sessionId, loop),
      failed: (sessionId, message) => this.notifyLoopFailure(sessionId, message),
      warn: (message) => options.log.warn(message),
    });
    this.loops.restore();
    this.usageProbe = new UsageProbe({
      root: options.usageProbeRoot,
      launch: (agent, cwd, onUpdate, account) =>
        this.spawnTemporary(
          agent,
          cwd,
          {
            onSessionUpdate: onUpdate,
            onPermissionRequest: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
          },
          options.accounts.env(account.agentId, account.accountId),
        ),
      prepare: (agentId, accountId) => options.accounts.prepare(agentId, accountId),
      blocked: (agentId, accountId) => options.accounts.isRemoving(agentId, accountId),
      log: options.log,
      timeoutMs: options.usageTimeoutMs ?? USAGE_TIMEOUT_MS,
      // A fixed budget from the caller (tests) applies to every agent; otherwise each agent gets its own.
      timeoutFor: options.usageTimeoutMs === undefined ? usageTimeoutOf : undefined,
      cacheMs: options.usageCacheMs ?? USAGE_CACHE_MS,
      idleMs: options.usageIdleMs ?? USAGE_IDLE_MS,
      cancelGraceMs: USAGE_CANCEL_GRACE_MS,
    });
    this.resets = new ResetService({
      usage: this.usageProbe,
      workRoot: options.usageProbeRoot,
      appVersion: options.appVersion,
      timeoutMs: options.usageTimeoutMs ?? USAGE_TIMEOUT_MS,
      cacheMs: options.usageCacheMs ?? USAGE_CACHE_MS,
      log: options.log,
    });
    this.agentImages = new AgentImages({
      db: options.db,
      filesRoot: options.filesRoot,
      allowedRoots: options.config.allowedRoots,
      log: options.log,
    });
    this.userQuestions = new UserQuestions(options.db, (sessionId, event) => {
      const recorded = this.appendEvent(sessionId, event, { notify: event.kind === 'user_question' });
      if (recorded === undefined) throw new Error('failed to persist user question');
    }, options.askUserTimeoutMs);
    this.fileRequests = new FileRequests(options.db, (sessionId, event) => {
      const recorded = this.appendEvent(sessionId, event, { notify: event.kind === 'file_request' });
      if (recorded === undefined) throw new Error('failed to persist file request');
    }, options.requestFileTimeoutMs);
  }

  async create(input: CreateSessionRequest): Promise<Session> {
    if (input.agent === SHELL_AGENT_ID) return this.createShell(input);
    if (input.shell !== undefined) throw new SessionError('invalid_request', 'shell só vale com agent "shell"');
    if (input.resumeAcpSessionId !== undefined) {
      return this.importSession({ ...input, resumeAcpSessionId: input.resumeAcpSessionId });
    }
    const { db } = this.options;
    const workspace = findWorkspaceById(db, input.workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    const agent = this.agentOf(input.agent);
    const accountId = this.chooseAccount(input.agent, input.accountId);
    this.requireFreeSlot();

    const id = randomUUID();
    // Reserva a vaga já: o worktree é criado com await, e outra criação não pode passar do teto nesse intervalo.
    // A reserva também diz de que conta é (remover a conta enquanto isso é recusado).
    this.reserved.set(id, { agent: input.agent, accountId });
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
        accountId,
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

  /** Validation only: explicit accounts never inherit the foreground agent's active account. */
  validateScheduledAgent(workspaceId: string, agentId: string, accountId: string): void {
    const workspace = findWorkspaceById(this.options.db, workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    try {
      resolveInsideRoots(workspace.path, this.options.config.allowedRoots);
    } catch (error) {
      if (error instanceof PathError) throw new SessionError(error.code === 'outside_roots' ? 'outside_roots' : 'invalid_request', error.message);
      throw error;
    }
    if (this.agentOf(agentId).kind !== 'acp') throw new SessionError('not_acp', 'agendamento exige agente ACP');
    this.chooseAccount(agentId, accountId);
  }

  /** Fresh automation ownership and subscription are installed before the first broadcast or asynchronous startup. */
  async createScheduled(run: ScheduleRun, signal: AbortSignal, created: (sessionId: string) => void): Promise<Session> {
    if (run.task.kind !== 'agent') throw new SessionError('invalid_request', 'agendamento não é de agente');
    const task = run.task;
    signal.throwIfAborted();
    this.validateScheduledAgent(run.workspaceId, task.agentId, task.accountId);
    this.requireFreeSlot();
    const workspace = findWorkspaceById(this.options.db, run.workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    const cwd = resolveInsideRoots(workspace.path, this.options.config.allowedRoots);
    const agent = this.agentOf(task.agentId);
    const accountId = this.chooseAccount(task.agentId, task.accountId);
    const id = randomUUID();
    insertSession(this.options.db, {
      id, workspaceId: run.workspaceId, agent: task.agentId, kind: 'acp',
      title: run.scheduleName, status: 'starting', createdAt: Date.now(),
      accountId, automationRunId: run.id,
    });
    const abort = (): void => { void this.stopScheduled(id).catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    this.scheduledClaims.set(id, { agent: task.agentId, accountId });
    try {
      created(id);
      signal.throwIfAborted();
      this.announceStatus(id, 'starting');
      await scheduledWait(this.options.accounts.prepare(task.agentId, accountId), signal);
      signal.throwIfAborted();
      if (this.load(id).status !== 'starting') throw new SessionError('agent_failed', 'scheduled startup was stopped');
      resolveInsideRoots(cwd, this.options.config.allowedRoots);
      // The explicit account is reselected after preparation; deletion may not silently switch it to principal.
      this.chooseAccount(task.agentId, task.accountId);
      const live = this.spawnLive(id, cwd, agent, {
        claim: { agent: task.agentId, accountId },
        env: this.options.accounts.env(task.agentId, accountId),
      });
      this.scheduledProcesses.set(id, live);
      const startup = async (): Promise<void> => {
        const initialized = await live.connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
        });
        signal.throwIfAborted();
        if (!this.isCurrent(live)) throw new SessionError('agent_failed', 'scheduled agent stopped during startup');
        live.promptImage = initialized.agentCapabilities?.promptCapabilities?.image === true;
        live.restorable = restoreMethodOf(initialized.agentCapabilities) !== undefined;
        const opened = await live.connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: live.mcpServers });
        signal.throwIfAborted();
        if (!this.isCurrent(live)) throw new SessionError('agent_failed', 'scheduled agent stopped during startup');
        live.acpSessionId = opened.sessionId;
        updateSession(this.options.db, id, { acpSessionId: opened.sessionId }, Date.now());
        this.applyAgentConfig(live, opened);
        this.persistConfig(live);
        if (task.model !== '') {
          const model = live.configOptions.find((option) => option.type === 'select' && (option.category === 'model' || option.id === 'model'));
          if (model === undefined) throw new SessionError('invalid_request', 'agente não oferece seleção de modelo');
          const response = await live.connection.agent.request(acp.methods.agent.session.setConfigOption, {
            sessionId: opened.sessionId, configId: model.id, value: task.model,
          });
          signal.throwIfAborted();
          if (!this.isCurrent(live)) throw new SessionError('agent_failed', 'scheduled agent stopped during model selection');
          live.configOptions = flattenConfigOptions(response.configOptions);
          const applied = live.configOptions.find((option) => option.id === model.id);
          if (applied?.type !== 'select' || applied.currentValue !== task.model) {
            throw new SessionError('invalid_request', 'modelo solicitado indisponível; nenhum prompt foi enviado');
          }
          this.persistConfig(live);
        }
        this.setStatus(id, 'idle');
      };
      await scheduledWait(Promise.race([
        startup(),
        live.exited.then(() => { throw new SessionError('agent_failed', 'agente encerrou durante inicialização'); }),
      ]), signal);
      signal.throwIfAborted();
      return this.load(id);
    } catch (error) {
      if (!signal.aborted) this.fail(id, messageOf(error));
      await this.stopScheduled(id);
      throw error;
    } finally {
      this.scheduledClaims.delete(id);
      signal.removeEventListener('abort', abort);
    }
  }

  /** Joins the owned process even when an ACP failure has already detached it from the ordinary live map. */
  async stopScheduled(sessionId: string): Promise<void> {
    const process = this.scheduledProcesses.get(sessionId);
    try {
      await this.stop(sessionId);
      if (process !== undefined) {
        killAgent(process.child);
        await withTimeout(process.exited, KILL_TIMEOUT_MS, 'encerrar agente agendado');
      }
    } finally {
      this.scheduledProcesses.delete(sessionId);
    }
  }

  /** Temporary initialize/newSession only: no prompt, permission grants, persisted session or settings mutation. */
  async scheduleModels(workspaceId: string, agentId: string, requestedAccount: string, signal: AbortSignal): Promise<ScheduleModelsResponse> {
    signal.throwIfAborted();
    this.validateScheduledAgent(workspaceId, agentId, requestedAccount);
    this.requireFreeSlot();
    if (this.listing.has(agentId)) throw new SessionError('busy', 'já há uma consulta em andamento para este agente');
    const workspace = findWorkspaceById(this.options.db, workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    const cwd = resolveInsideRoots(workspace.path, this.options.config.allowedRoots);
    const accountId = this.chooseAccount(agentId, requestedAccount);
    const claimId = randomUUID();
    this.reserved.set(claimId, { agent: agentId, accountId });
    this.listing.add(agentId);
    try {
      await scheduledWait(this.options.accounts.prepare(agentId, accountId), signal, this.agentListTimeoutMs);
      signal.throwIfAborted();
      this.chooseAccount(agentId, requestedAccount);
      return await this.probeAgent(this.agentOf(agentId), cwd, this.agentListTimeoutMs, async (connection) => {
        await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        signal.throwIfAborted();
        const opened = await connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
        signal.throwIfAborted();
        const option = flattenConfigOptions(opened.configOptions ?? []).find((item) =>
          item.type === 'select' && (item.category === 'model' || item.id === 'model'));
        if (option?.type !== 'select') return { models: [], currentModel: null, supported: false };
        return { models: option.options.map((item) => ({ id: item.value, name: item.name })), currentModel: option.currentValue, supported: true };
      }, this.options.accounts.env(agentId, accountId), signal);
    } finally {
      this.reserved.delete(claimId);
      this.listing.delete(agentId);
    }
  }

  /**
   * Terminal de workspace (`agent: "shell"`, PLAN.md, "terminal no workspace"): um PTY com o shell escolhido (ou o
   * padrão), na pasta do workspace (ou no worktree, se pedido). Mesmo caminho do terminal `agy`, sem agente nem token.
   * A pasta do workspace precisa estar dentro de `allowedRoots` agora, não só quando foi cadastrada.
   */
  private async createShell(input: CreateSessionRequest): Promise<Session> {
    const { db, config } = this.options;
    if (!config.shellSessions) {
      throw new SessionError('shell_disabled', 'terminal de workspace desligado (shellSessions no config.json)');
    }
    if (input.resumeAcpSessionId !== undefined) {
      throw new SessionError('invalid_request', 'terminal não importa sessão do agente');
    }
    const workspace = findWorkspaceById(db, input.workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    try {
      resolveInsideRoots(workspace.path, config.allowedRoots);
    } catch (error) {
      if (error instanceof PathError && error.code === 'outside_roots') {
        throw new SessionError('outside_roots', 'pasta do workspace está fora das pastas permitidas');
      }
      throw new SessionError('not_found', 'pasta do workspace não existe mais');
    }
    this.chooseAccount(SHELL_AGENT_ID, input.accountId);
    const shell = chooseShell(localShells(), input.shell);
    if (shell === undefined) {
      const detail = input.shell === undefined ? 'nenhum shell encontrado neste PC' : `shell ${input.shell} não encontrado neste PC`;
      throw new SessionError('shell_unavailable', detail);
    }
    this.requireFreeSlot();

    const id = randomUUID();
    this.reserved.set(id, undefined);
    let worktree: Worktree | null;
    try {
      worktree = input.worktree === true ? await this.createWorktree(workspace, id) : null;
      insertSession(db, {
        id,
        workspaceId: workspace.id,
        agent: SHELL_AGENT_ID,
        kind: 'pty',
        title: `Terminal · ${shell.id}`,
        status: 'starting',
        createdAt: Date.now(),
        worktree,
      });
    } finally {
      this.reserved.delete(id);
    }
    this.announceStatus(id, 'starting');
    this.startShellTerminal(id, worktree?.path ?? workspace.path, shell);
    return this.load(id);
  }

  /**
   * Antes do reload: cada shell vivo grava `terminal_exit` com `reason: "reload"` (sem Web Push), vira `stopped` e o
   * PTY morre. Chamado pelo caminho de reload do main, antes de fechar os WS e o servidor.
   */
  closeShellsForReload(): void {
    for (const terminal of [...this.terminals.values()]) {
      if (this.load(terminal.id).agent !== SHELL_AGENT_ID) continue;
      terminal.batcher.end();
      this.appendEvent(terminal.id, { kind: 'terminal_exit', exitCode: null, reason: 'reload' }, { notify: false });
      this.detachTerminal(terminal);
      this.setStatus(terminal.id, 'stopped');
      terminal.process.kill();
    }
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
   * status `error` com evento. Devolve a sessão como ficou no banco. Retomada já em curso: espera a mesma.
   * `markStarting`: grava `starting` enquanto o agente carrega a sessão (retomada automática depois de reload).
   */
  async resume(sessionId: string, options: ResumeOptions = {}): Promise<Session> {
    return (await this.resumeOnce(sessionId, options)).session;
  }

  /**
   * Uma retomada por sessão de cada vez: quem chega com uma já em curso (Retomar, reload ou prompt) recebe o
   * mesmo resultado, então nunca sobe dois agentes para a mesma sessão. As opções da segunda chamada são ignoradas.
   */
  private resumeOnce(sessionId: string, options: ResumeOptions): Promise<ResumeOutcome> {
    if (this.forgetting.has(sessionId)) throw new SessionError('session_busy', 'Session history cleanup is in progress.');
    const running = this.resumes.get(sessionId);
    if (running !== undefined) return running;
    const attempt = this.startResume(sessionId, options);
    this.resumes.set(sessionId, attempt);
    // Registrado antes de qualquer `await` de quem espera: quando o chamador continua, o mapa já está limpo.
    const forget = (): void => {
      this.resumes.delete(sessionId);
    };
    attempt.then(forget, forget);
    return attempt;
  }

  private async startResume(sessionId: string, options: ResumeOptions): Promise<ResumeOutcome> {
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
      const failure = `pasta não existe mais: ${cwd}`;
      this.markFailed(sessionId, failure);
      return { session: this.load(sessionId), failure };
    }

    this.reserved.set(sessionId, { agent: session.agent, accountId: session.accountId });
    let failure: string | undefined;
    try {
      const savedOptions = findSessionConfigOptions(this.options.db, sessionId) ?? [];
      failure = await this.restore(sessionId, cwd, agent, acpSessionId, savedOptions, options.markStarting === true);
    } finally {
      this.reserved.delete(sessionId);
    }
    return { session: this.load(sessionId), failure };
  }

  /**
   * Garante um processo vivo antes de um turno. Sessão sem processo e com status `stopped`/`error` é retomada pelo
   * mesmo caminho do Retomar, com `starting` enquanto carrega. Retomada já em curso é esperada, nunca repetida.
   * Falha da retomada vira erro do prompt; sessão que não retoma (PTY, sem acp_session_id, agente sem
   * loadSession/resume) vira `not_resumable` com a mensagem de criar uma nova.
   */
  private async ensureLive(sessionId: string): Promise<void> {
    const resuming = this.resumes.has(sessionId);
    if (!resuming && (this.isLive(sessionId) || !TERMINAL_STATUSES.includes(this.load(sessionId).status))) return;

    let outcome: ResumeOutcome;
    try {
      outcome = await this.resumeOnce(sessionId, { markStarting: true });
    } catch (error) {
      if (error instanceof SessionError && error.code === 'not_resumable') {
        throw new SessionError('not_resumable', NOT_RESUMABLE_PROMPT_MESSAGE);
      }
      throw error;
    }
    if (outcome.failure !== undefined) throw new SessionError('agent_failed', outcome.failure);
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
   * Sessão parada ou com erro é retomada antes (ver ensureLive). Ordem: validação dos anexos (um id inválido não
   * sobe agente), retomada, leitura dos anexos (imagem inline depende do agente já subido), conferência de estado.
   * Depois da conferência de estado não há await.
   */
  async prompt(
    sessionId: string,
    text: string,
    attachmentIds: readonly string[] = [],
    turn?: LoopTurn,
    queued?: PendingPrompt,
  ): Promise<void> {
    const records = this.attachmentRecords(sessionId, attachmentIds);
    await this.ensureLive(sessionId);
    this.requireAcp(sessionId);
    const attachments = await this.loadAttachments(this.requireLive(sessionId), records);

    const live = this.requireLive(sessionId);
    if (live.status !== 'idle' || live.acpSessionId === undefined || live.promptQueue[0] !== queued) {
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
      ...(turn !== undefined ? { loop: true as const, loopIteration: turn.iteration } : {}),
    });
    if (queued !== undefined) {
      live.promptQueue.shift();
      this.broadcastPromptQueue(sessionId);
    }
    const session = this.load(sessionId);
    if (session.title === DEFAULT_TITLE && title !== undefined) {
      updateSession(this.options.db, sessionId, { title }, Date.now());
      this.broadcastSession(sessionId);
    }

    // The dynamic loop instruction stays out of slash commands, where it would become an argument.
    const extra = turn?.selfPaced === true && !isSlashCommand(text) ? LOOP_SELF_PACE_INSTRUCTION : undefined;
    live.cancelRequested = false;
    const sourceModel = live.configOptions.find((option) => option.type === 'select' && (option.category === 'model' || option.id === 'model'));
    live.turnSource = {
      agentId: live.agentId,
      accountId: live.claim.accountId,
      model: sourceModel?.type === 'select' ? sourceModel.currentValue : '',
    };
    live.promptInFlight = true;
    this.setStatus(sessionId, 'running');
    live.connection.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId: acpSessionId,
        prompt: promptBlocks(text, attachments, extra),
      })
      .then(
        (response) => {
          if (!this.isCurrent(live)) return;
          live.promptInFlight = false;
          this.userQuestions.cancelSession(sessionId);
          this.fileRequests.cancelSession(sessionId);
          // `error` não existe em ACP v1 (o tipo do SDK não o tem); quando vier, vira erro visível (e push).
          const stopReason: string = live.cancelRequested ? 'cancelled' : response.stopReason;
          if (stopReason === 'error') this.appendEvent(sessionId, { kind: 'error', message: 'turno terminou com erro' });
          const ended = this.appendEvent(sessionId, { kind: 'turn_end', stopReason });
          if (stopReason === 'end_turn' && !live.cancelRequested && ended !== undefined && this.load(sessionId).automationRunId === undefined) {
            try {
              this.options.onTurnCompleted?.(sessionId, ended.seq);
            } catch {
              this.options.log.warn({ sessionId }, 'automatic learning completion callback failed');
            }
          }
          this.loops.turnEnded(sessionId, { stopReason });
          this.setStatus(sessionId, 'idle');
        },
        (error: unknown) => {
          const message = messageOf(error);
          // Falha com o processo já tirado (agente caiu, sessão parada): o erro já foi gravado por quem tirou.
          // O loop precisa saber mesmo assim, para pausar.
          if (this.isCurrent(live)) {
            live.promptInFlight = false;
            this.userQuestions.cancelSession(sessionId);
            this.fileRequests.cancelSession(sessionId);
            this.appendEvent(sessionId, { kind: 'error', message });
          }
          this.loops.turnEnded(sessionId, { error: message });
          if (this.isCurrent(live)) this.setStatus(sessionId, 'idle');
        },
      );
  }

  async submitPrompt(sessionId: string, text: string, attachmentIds: readonly string[]): Promise<void> {
    const live = this.live.get(sessionId);
    if (live === undefined) {
      await this.prompt(sessionId, text, attachmentIds);
      return;
    }
    if (live.status === 'starting' || live.acpSessionId === undefined) {
      throw new SessionError('session_busy', 'agente ainda não abriu a sessão');
    }
    if (live.promptQueue.length >= MAX_QUEUED_PROMPTS) {
      throw new SessionError('prompt_queue_full', 'fila de mensagens cheia');
    }
    this.attachmentRecords(sessionId, attachmentIds);
    live.promptQueue.push({ id: randomUUID(), text, attachmentIds, failed: false });
    this.broadcastPromptQueue(sessionId);
    this.drainPromptQueue(live);
  }

  promptQueueOf(sessionId: string): QueuedPrompt[] {
    return this.live.get(sessionId)?.promptQueue.map(({ id, text, attachmentIds, failed }) => ({
      id,
      preview: text.slice(0, 200),
      attachments: attachmentIds.length,
      failed,
    })) ?? [];
  }

  removeQueuedPrompt(sessionId: string, id: string): void {
    this.requireAcp(sessionId);
    const live = this.live.get(sessionId);
    const index = live?.promptQueue.findIndex((item) => item.id === id) ?? -1;
    if (live === undefined || index < 0) return;
    live.promptQueue.splice(index, 1);
    this.broadcastPromptQueue(sessionId);
    this.drainPromptQueue(live);
  }

  private broadcastPromptQueue(sessionId: string): void {
    const queue = this.promptQueueOf(sessionId);
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener.promptQueue(queue);
      } catch (error) {
        this.options.log.warn({ err: error, sessionId }, 'prompt queue listener failed');
      }
    }
  }

  private drainPromptQueue(live: LiveSession): void {
    const next = live.promptQueue[0];
    if (!this.isCurrent(live) || live.status !== 'idle' || live.drainingPromptQueue || next === undefined || next.failed) return;
    live.drainingPromptQueue = true;
    void this.prompt(live.id, next.text, next.attachmentIds, undefined, next)
      .catch((error: unknown) => {
        if (!this.isCurrent(live) || live.promptQueue[0] !== next) return;
        this.options.log.warn({ err: error, sessionId: live.id }, 'queued message failed to start');
        next.failed = true;
        this.broadcastPromptQueue(live.id);
      })
      .finally(() => {
        live.drainingPromptQueue = false;
        this.drainPromptQueue(live);
      });
  }

  /** Loop da sessão, ou null. Sessão inexistente → not_found. */
  loopOf(sessionId: string): Loop | null {
    this.load(sessionId);
    return this.loops.get(sessionId);
  }

  /** PUT do loop: cria ou troca. Só sessão de agente (ACP); terminal → not_acp. */
  putLoop(sessionId: string, request: LoopRequest): Loop {
    if (this.load(sessionId).kind === 'pty') throw new SessionError('not_acp', 'loop só vale para sessão de agente');
    return this.loopCall(() => this.loops.create(sessionId, request));
  }

  pauseLoop(sessionId: string): Loop {
    this.load(sessionId);
    return this.loopCall(() => this.loops.pause(sessionId));
  }

  resumeLoop(sessionId: string): Loop {
    this.load(sessionId);
    return this.loopCall(() => this.loops.resume(sessionId));
  }

  runLoopNow(sessionId: string): Loop {
    this.load(sessionId);
    return this.loopCall(() => this.loops.runNow(sessionId));
  }

  /** DELETE do loop: para e apaga. Sem loop → loop_not_found. */
  deleteLoop(sessionId: string): void {
    this.load(sessionId);
    this.loopCall(() => this.loops.remove(sessionId));
  }

  /** Erros do loop viram SessionError (os códigos HTTP ficam no server). */
  private loopCall<T>(action: () => T): T {
    try {
      return action();
    } catch (error) {
      if (error instanceof LoopError) throw new SessionError(error.code, error.message);
      throw error;
    }
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

  askUser(sessionId: string, request: AskUserRequest, signal: AbortSignal): Promise<AskUserResult> {
    const live = this.requireLive(sessionId);
    if (!live.promptInFlight || live.cancelRequested) {
      throw new SessionError('session_not_active', 'perguntas exigem um turno ativo');
    }
    return this.userQuestions.ask(sessionId, request, signal);
  }

  respondUserQuestion(sessionId: string, requestId: string, optionId: string | null): AskUserResult {
    return this.userQuestions.respond(sessionId, requestId, optionId);
  }

  requestFile(sessionId: string, request: RequestFileRequest, signal: AbortSignal): Promise<RequestFileAgentResult> {
    const live = this.requireLive(sessionId);
    if (!live.promptInFlight || live.cancelRequested) {
      throw new SessionError('session_not_active', 'pedidos de arquivo exigem um turno ativo');
    }
    return this.fileRequests.request(sessionId, request, signal);
  }

  respondFileRequest(sessionId: string, requestId: string, fileId: string | null): RequestFileResult {
    return this.fileRequests.respond(sessionId, requestId, fileId);
  }

  recordPreview(sessionId: string, info: PreviewInfo): SessionEvent {
    const live = this.requireLive(sessionId);
    if (!live.promptInFlight || live.cancelRequested) {
      throw new SessionError('session_not_active', 'pré-visualizações exigem um turno ativo');
    }
    const event = this.appendEvent(sessionId, { ...info, kind: 'preview' });
    if (event === undefined) throw new Error('failed to persist preview');
    return event;
  }

  /** A detached process may still need its persisted preview card marked closed. */
  recordPreviewClosed(sessionId: string, previewId: string, reason: PreviewCloseReason): SessionEvent {
    const event = this.appendEvent(sessionId, { kind: 'preview_closed', previewId, reason }, { notify: false });
    if (event === undefined) throw new Error('failed to persist preview closure');
    return event;
  }

  learningSource(sessionId: string): LearningTurnSource | undefined {
    return this.live.get(sessionId)?.turnSource;
  }

  /** Learning is quiet: no attention push, status, unread counter, or primary conversation turn. */
  recordLearning(sessionId: string, notice: LearningNotice): void {
    const event = this.appendEvent(sessionId, { kind: 'learning', ...notice }, { notify: false });
    if (event === undefined) throw new Error('failed to persist learning notice');
  }

  /** Resolve long HTTP waiters before Fastify starts draining connections. */
  closePendingRequests(): void {
    this.userQuestions.close();
    this.fileRequests.close();
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
    this.options.onSessionRevoked?.(sessionId);
    this.requireAcp(sessionId);
    const live = this.requireLive(sessionId);
    live.cancelRequested = true;
    this.userQuestions.cancelSession(sessionId);
    this.fileRequests.cancelSession(sessionId);
    if (live.acpSessionId !== undefined) {
      live.connection.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: live.acpSessionId })
        .catch((error: unknown) => this.options.log.warn({ err: error, sessionId }, 'session/cancel falhou'));
    }
    this.resolvePermission(live, null);
  }

  /**
   * Leitura de uso do agente (`/usage` ou `/status`, ver agent-usage.ts) num processo ACP de uso, separado da sessão:
   * vale com a sessão rodando, parada ou com erro. Só precisa de a sessão existir e de o agente ter um comando de uso.
   * Nada é gravado nem transmitido (ver usage-probe.ts).
   */
  async usage(sessionId: string): Promise<UsageResponse> {
    const session = this.load(sessionId);
    if (session.kind === 'pty') throw new SessionError('usage_unsupported', 'terminal não mostra uso');
    const command = usageCommandOf(session.agent);
    if (command === undefined) throw new SessionError('usage_unsupported', 'agente sem comando de uso');
    const agent = this.agentOf(session.agent);
    const accountId = this.options.accounts.effective(session.agent, session.accountId);
    try {
      return await this.usageProbe.read(session.agent, agent, command, accountId);
    } catch (error) {
      if (error instanceof UsageProbeError) throw new SessionError(error.code, error.message);
      throw error;
    }
  }

  /**
   * Resets salvos da sessão (omp ou codex; ver reset-service.ts). Não toca a sessão: nada é gravado nem transmitido,
   * e a sessão não é retomada.
   */
  async resetsOf(sessionId: string): Promise<ResetsResponse> {
    const target = this.resetTargetOf(sessionId);
    try {
      return await this.resets.list(target);
    } catch (error) {
      throw sessionErrorOf(error);
    }
  }

  /** Gasta um reset salvo da sessão (`target` de uma linha da listagem). Ver ResetService.redeem. */
  async redeemReset(sessionId: string, target: string): Promise<ResetRedeemResponse> {
    const resetTarget = this.resetTargetOf(sessionId);
    try {
      return await this.resets.redeem(resetTarget, target);
    } catch (error) {
      throw sessionErrorOf(error);
    }
  }

  /**
   * Alvo dos resets da sessão: o agente dela, se tem fonte de resets. PTY e agentes sem fonte → resets_unsupported.
   * O codex usa a conta da sessão (chave `codex:<conta>`, `CODEX_HOME` da conta e o preparo da pasta antes do app-server).
   * O omp não tem contas no Nanachi: a chave é só o agente, sem env, qualquer que seja o `account_id` da sessão.
   */
  private resetTargetOf(sessionId: string): ResetTarget {
    const session = this.load(sessionId);
    if (session.kind === 'pty' || resetSourceOf(session.agent) === undefined) {
      throw new SessionError('resets_unsupported', 'agente sem resets salvos');
    }
    const target: ResetTarget = { agentId: session.agent, agent: this.agentOf(session.agent) };
    if (resetSourceOf(session.agent) !== 'codex') return target;
    const accountId = this.options.accounts.effective(session.agent, session.accountId);
    const { accounts } = this.options;
    if (accountId === null) {
      // The principal: nothing to add, except removing a home variable the daemon inherited from an extra account.
      const inherited = accounts.env(session.agent, null);
      return Object.keys(inherited).length === 0 ? target : { ...target, extraEnv: inherited };
    }
    return {
      ...target,
      accountKey: resetKeyOf(session.agent, accountId),
      accountId,
      extraEnv: accounts.env(session.agent, accountId),
      prepare: () => accounts.prepare(session.agent, accountId),
    };
  }

  async setConfig(sessionId: string, configId: string, value: ConfigValue): Promise<void> {
    this.requireAcp(sessionId);
    const live = this.requireLive(sessionId);
    await this.applyConfig(live, configId, value);
  }

  yoloOf(sessionId: string): boolean {
    return this.live.get(sessionId)?.yolo ?? false;
  }

  setYolo(sessionId: string, enabled: boolean): void {
    this.requireAcp(sessionId);
    const live = this.requireLive(sessionId);
    if (live.acpSessionId === undefined || live.status === 'starting') {
      throw new SessionError('session_busy', 'agente ainda não abriu a sessão');
    }
    live.yolo = enabled;
    this.options.broadcast({ type: 'yolo', sessionId, enabled });
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
    this.options.onSessionRevoked?.(sessionId);
    // Sessão que o usuário parou: o loop dela para também (senão o disparo a retomaria sozinho).
    this.loops.stop(sessionId);
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
    await this.stopLive(live);
  }

  /** Tira o processo do mapa, marca a sessão `stopped` e espera o agente sair. Sem push: parar não é um evento de aviso. */
  private async stopLive(live: LiveSession): Promise<void> {
    this.detach(live);
    this.setStatus(live.id, 'stopped');
    killAgent(live.child);
    await withTimeout(live.exited, KILL_TIMEOUT_MS, 'encerrar agente').catch(() => undefined);
  }

  /**
   * Troca a conta da sessão (PUT /api/sessions/:id/account). `requested` é o id da conta extra ou `default` (principal).
   * Mesma conta: nada muda. Agente trabalhando (starting, running, awaiting_permission) → `session_busy`. Senão grava a
   * conta e o evento `account_changed`; com processo vivo, para o agente (sem push) e o retoma pelo caminho do Retomar,
   * já na conta nova. Sessão parada ou com erro só grava: o próximo prompt retoma na conta nova.
   */
  async setAccount(sessionId: string, requested: string): Promise<Session> {
    const session = this.load(sessionId);
    if (session.kind === 'pty') throw new SessionError('not_acp', 'sessão de terminal não tem conta de agente');
    const next = this.chooseAccount(session.agent, requested);
    if (next === session.accountId) return session;
    if (
      ACCOUNT_BUSY_STATUSES.includes(session.status) ||
      this.switching.has(sessionId) ||
      this.resumes.has(sessionId) ||
      this.reserved.has(sessionId) ||
      this.forgetting.has(sessionId)
    ) {
      throw new SessionError('session_busy', `sessão está ocupada (status: ${session.status}): troque a conta quando o agente terminar`);
    }
    const live = this.live.get(sessionId);
    if (live?.restorable === false) {
      // Parar o agente e não conseguir retomar perderia a conversa: com este agente a conta só troca com a sessão parada.
      throw new SessionError('not_resumable', 'agente não permite retomar sessões: pare a sessão antes de trocar a conta');
    }

    // Both accounts are in use until the switch is over: the old agent is still being stopped, the new one is starting.
    this.switching.set(sessionId, [
      { agent: session.agent, accountId: session.accountId },
      { agent: session.agent, accountId: next },
    ]);
    try {
      updateSession(this.options.db, sessionId, { accountId: next }, Date.now());
      this.appendEvent(
        sessionId,
        { kind: 'account_changed', accountId: next, label: this.options.accounts.labelOf(session.agent, next) },
        { notify: false },
      );
      this.broadcastSession(sessionId);
      if (live !== undefined) {
        await this.stopLive(live);
        try {
          await this.resume(sessionId, { markStarting: true });
        } catch (error) {
          // Um prompt que chegou no meio já retomou a sessão (na conta nova): o resultado é o mesmo.
          if (!(error instanceof SessionError && error.code === 'already_running')) throw error;
        }
      }
    } finally {
      this.switching.delete(sessionId);
    }
    return this.load(sessionId);
  }

  /**
   * Is something in memory still using the account folder? A live agent process on it, a resume or a start in progress
   * (the row may still say "stopped"), an account switch from or to it, or a usage read or resets turn running on it. The
   * account service calls this before it deletes the folder, next to its own check of the sessions table. An idle usage
   * process is not in use: removing the account kills it (`releaseAccount`).
   */
  isAccountInUse(agentId: string, accountId: string): boolean {
    const uses = (claim: AccountClaim | undefined): boolean => claim?.agent === agentId && claim.accountId === accountId;
    for (const live of this.live.values()) {
      if (uses(live.claim)) return true;
    }
    for (const claim of this.reserved.values()) {
      if (uses(claim)) return true;
    }
    for (const claim of this.scheduledClaims.values()) {
      if (uses(claim)) return true;
    }
    for (const process of this.scheduledProcesses.values()) {
      if (uses(process.claim)) return true;
    }
    for (const claims of this.switching.values()) {
      if (claims.some(uses)) return true;
    }
    return this.usageProbe.isBusy(agentId, accountId);
  }

  /**
   * A conta extra foi removida: mata o processo de uso dela e esquece o que o serviço de resets guardou. O serviço de
   * contas chama isto antes de apagar a pasta do perfil (no Windows, um processo dentro dela impede apagar).
   */
  async releaseAccount(agentId: string, accountId: string): Promise<void> {
    this.resets.dropKey(resetKeyOf(agentId, accountId));
    await this.usageProbe.drop(agentId, accountId);
  }

  async forgetStopped(sessionId: string, cleanup: () => Promise<void>): Promise<void> {
    const session = this.load(sessionId);
    if (!TERMINAL_STATUSES.includes(session.status) ||
        this.live.has(sessionId) || this.terminals.has(sessionId) ||
        this.reserved.has(sessionId) || this.resumes.has(sessionId) ||
        this.switching.has(sessionId) || this.scheduledClaims.has(sessionId) ||
        this.scheduledProcesses.has(sessionId) || this.forgetting.has(sessionId)) {
      throw new SessionError('session_busy', 'Session must finish its current operation before history cleanup.');
    }
    this.forgetting.add(sessionId);
    try {
      await cleanup();
      this.options.onSessionRevoked?.(sessionId);
      this.forgetSessionRecords(sessionId);
    } finally {
      this.forgetting.delete(sessionId);
    }
  }

  /**
   * Tira a sessão do app: linha, eventos e registros de arquivos. Não fala com o agente (o histórico dele continua).
   * Quem chama para o processo antes (`stop`) e remove o worktree, se pedido. Sessão com operação em curso → 409.
   */
  forget(sessionId: string): void {
    this.options.onSessionRevoked?.(sessionId);
    this.load(sessionId);
    if (this.live.has(sessionId) || this.terminals.has(sessionId) || this.reserved.has(sessionId) ||
        this.resumes.has(sessionId) || this.switching.has(sessionId) || this.forgetting.has(sessionId) ||
        this.scheduledClaims.has(sessionId) || this.scheduledProcesses.has(sessionId)) {
      throw new SessionError('session_busy', 'sessão ainda está ativa: pare antes de remover');
    }
    this.forgetSessionRecords(sessionId);
  }

  private forgetSessionRecords(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.agentImages.forget(sessionId);
    this.loops.drop(sessionId);
    deleteSessionRows(this.options.db, sessionId);
  }

  /** Para as sessões informadas (ex.: workspace apagado). Ids sem processo só ficam como estão. */
  async stopSessions(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.stop(sessionId);
    }
  }

  /** Mata todos os agentes e espera saírem. Perguntas pendentes são canceladas no histórico antes do detach. */
  async shutdown(): Promise<void> {
    this.closePendingRequests();
    // Processos de uso são temporários e ficam em `running`: o laço abaixo também os mata e espera.
    this.usageProbe.close();
    // O app-server do codex dos resets não passa por `running`: o serviço mata o que estiver em andamento.
    this.resets.close();
    // Sem disparos de loop depois do shutdown: o banco pode fechar logo em seguida.
    this.loops.close();
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

  /** Conta de uma sessão nova ou da troca de conta (ver AccountLauncher.choose). Recusa vira SessionError. */
  private chooseAccount(agentId: string, requested: string | undefined): string | null {
    try {
      return this.options.accounts.choose(agentId, requested);
    } catch (error) {
      if (error instanceof AccountSelectionError) throw new SessionError(error.code, error.message);
      throw error;
    }
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
  private agentLaunch(
    id: string,
    agent: AgentConfig,
    accountEnv: NodeJS.ProcessEnv = {},
  ): { command: AgentCommand; env: NodeJS.ProcessEnv } {
    const token = this.agentTokens.issue(id);
    // Launchers do phone-send e node_modules/.bin vêm antes do PATH: `claude-agent-acp` roda sem instalação global.
    // A pasta da conta extra vem depois do env do agente (vale sobre um CLAUDE_CONFIG_DIR do config ou do daemon); a
    // conta principal não traz nada e o agente usa a pasta dele do jeito de sempre.
    // As variáveis do daemon vêm depois do env do agente: o config não consegue sobrescrevê-las.
    // `mergeEnv`: no Windows `Claude_Config_Dir` e `CLAUDE_CONFIG_DIR` são a mesma variável, e uma chave `undefined` (a
    // pasta herdada de uma conta extra que a principal ignora) tira a variável do env.
    const env = withPathPrepended(
      mergeEnv([
        process.env,
        agent.env,
        accountEnv,
        {
          AGENT_SESSION_ID: id,
          NANACHI_URL: this.options.agentApiUrl(),
          NANACHI_AGENT_TOKEN: token,
        },
      ]),
      [phoneSendBinDir(), ...agentBinDirs()],
    );
    return { command: resolveAgentCommand(agent.command, agent.args, env), env };
  }

  /** Sobe o processo do agente no cwd e registra a conexão. Lança se o executável não existe. */
  private spawnLive(id: string, cwd: string, agent: AgentConfig, account: AccountLaunch): LiveSession {
    const { log } = this.options;
    try {
      const { command, env } = this.agentLaunch(id, agent, account.env);
      const mcpServers = this.options.nanachiMcpEnabled?.(account.claim.agent) === true
        ? [nanachiMcpDescriptor(env, cwd)]
        : [];
      const child = spawnAgent(command, {
        cwd,
        env,
        onDiagnostic: (line) => log.debug({ sessionId: id, agent: agent.label }, line),
      });
      return this.attach(id, child, account.claim, mcpServers);
    } catch (error) {
      this.agentTokens.revoke(id);
      throw error;
    }
  }

  /** Sobe o shell de uma sessão de terminal de workspace. Não sobe → error, como um agente que não sobe. */
  private startShellTerminal(id: string, cwd: string, shell: ShellOption): void {
    try {
      const command: AgentCommand = { file: shell.file, args: [...shell.args], shell: false };
      const pty = spawnPty(command, { cwd, env: shellEnvironment(process.env), cols: TERMINAL_COLS, rows: TERMINAL_ROWS });
      this.attachTerminal(id, pty);
    } catch (error) {
      this.fail(id, messageOf(error));
      return;
    }
    this.setStatus(id, 'running');
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

  /**
   * Env a mais do agente da sessão: a pasta da conta extra dela, com o perfil já preparado (`prepareProfile` antes de
   * cada processo). A conta vem da linha da sessão; conta que sumiu cai na principal (aviso no log) e não traz nada.
   */
  private async accountEnvOf(sessionId: string): Promise<AccountLaunch> {
    const session = this.load(sessionId);
    const { accounts } = this.options;
    const accountId = accounts.effective(session.agent, session.accountId);
    // An account that is being removed refuses the prepare: the start fails cleanly instead of bringing the folder back.
    await accounts.prepare(session.agent, accountId);
    return { claim: { agent: session.agent, accountId }, env: accounts.env(session.agent, accountId) };
  }

  private async start(id: string, cwd: string, agent: AgentConfig, requested: Record<string, ConfigValue>): Promise<void> {
    let live: LiveSession;
    try {
      live = this.spawnLive(id, cwd, agent, await this.accountEnvOf(id));
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
      live.restorable = restoreMethodOf(initialized.agentCapabilities) !== undefined;
      const created = await withTimeout(
        connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: live.mcpServers }),
        START_TIMEOUT_MS,
        'session/new',
      );

      live.acpSessionId = created.sessionId;
      updateSession(this.options.db, id, { acpSessionId: created.sessionId }, Date.now());
      this.applyAgentConfig(live, created);
      this.persistConfig(live);

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
   * Devolve a mensagem da falha que já foi gravada como evento `error` (o prompt a usa como erro); undefined se deu certo
   * ou se a sessão foi parada no meio da retomada (aí quem chama vê o status real).
   */
  private async restore(
    id: string,
    cwd: string,
    agent: AgentConfig,
    acpSessionId: string,
    savedOptions: SessionConfigOption[],
    markStarting: boolean,
  ): Promise<string | undefined> {
    let live: LiveSession;
    try {
      live = this.spawnLive(id, cwd, agent, await this.accountEnvOf(id));
    } catch (error) {
      const failure = messageOf(error);
      this.markFailed(id, failure);
      return failure;
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
      live.restorable = method !== undefined;
      live.promptImage = initialized.agentCapabilities?.promptCapabilities?.image === true;
    } catch (error) {
      if (!this.isCurrent(live)) return undefined;
      const failure = messageOf(error);
      this.fail(id, failure);
      return failure;
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
      const params = { sessionId: acpSessionId, cwd, mcpServers: live.mcpServers };
      const pending: Promise<acp.LoadSessionResponse | acp.ResumeSessionResponse> =
        method === 'load'
          ? live.connection.agent.request(acp.methods.agent.session.load, params)
          : live.connection.agent.request(acp.methods.agent.session.resume, params);
      const response = await withTimeout(pending, START_TIMEOUT_MS, method === 'load' ? 'session/load' : 'session/resume');
      if (!this.isCurrent(live)) return undefined;
      live.replaying = false;
      this.applyAgentConfig(live, response);
      this.persistConfig(live);
      this.setStatus(id, 'idle');
      return undefined;
    } catch (error) {
      if (!this.isCurrent(live)) return undefined;
      const failure = messageOf(error);
      this.fail(id, failure);
      return failure;
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
  private attach(id: string, child: AgentChild, claim: AccountClaim, mcpServers: acp.McpServer[]): LiveSession {
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
      onPermissionRequest: (request, signal) => this.requestPermission(live, request, signal),
    });
    const live: LiveSession = {
      agentId: claim.agent,
      id,
      child,
      connection,
      exited,
      claim,
      acpSessionId: undefined,
      configOptions: [],
      turnSource: undefined,
      usesSetMode: false,
      status: 'starting',
      promptInFlight: false,
      cancelRequested: false,
      promptQueue: [],
      drainingPromptQueue: false,
      yolo: false,
      pending: undefined,
      replaying: false,
      promptImage: false,
      restorable: undefined,
      history: undefined,
      mcpServers,
      toolCalls: new Map(),
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
        return;
      case 'current_mode_update': {
        const modeId = update.currentModeId;
        live.configOptions = live.configOptions.map((option) =>
          option.category === 'mode' && option.type === 'select' ? { ...option, currentValue: modeId } : option,
        );
        this.persistConfig(live);
        return;
      }
      default: {
        const draft = sessionUpdateToDraft(update, this.imageSink(id), live.toolCalls);
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
    const accountId = this.chooseAccount(input.agent, input.accountId);

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
      accountId,
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
      live = this.spawnLive(id, cwd, agent, await this.accountEnvOf(id));
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
      live.restorable = method !== undefined;
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
      const params = { sessionId: acpSessionId, cwd, mcpServers: live.mcpServers };
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
    const draft = sessionUpdateToDraft(update, this.imageSink(live.id), live.toolCalls);
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
   */
  private async probeAgent<T>(
    agent: AgentConfig,
    cwd: string,
    timeoutMs: number,
    run: (connection: acp.ClientConnection) => Promise<T>,
    accountEnv: NodeJS.ProcessEnv = {},
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const temp = this.spawnTemporary(agent, cwd, {
      onSessionUpdate: () => undefined,
      onPermissionRequest: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    }, accountEnv);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SessionError('agent_timeout', `agente não respondeu em ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    const died = temp.exited.then(() => {
      throw new SessionError('agent_failed', 'agente encerrou antes de responder');
    });
    try {
      const result = Promise.race([run(temp.connection), timeout, died]);
      return await (signal === undefined ? result : scheduledWait(result, signal, timeoutMs));
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError('agent_failed', messageOf(error));
    } finally {
      clearTimeout(timer);
      temp.kill();
      await withTimeout(temp.exited, KILL_TIMEOUT_MS, 'encerrar agente').catch(() => undefined);
    }
  }

  /**
   * Sobe um processo ACP fora do mapa de sessões, com token próprio (revogado quando o processo sai). Fica em
   * `running`, então o shutdown do daemon o alcança. Quem chama mata com `kill`.
   */
  private spawnTemporary(
    agent: AgentConfig,
    cwd: string,
    handlers: AcpHandlers,
    accountEnv: NodeJS.ProcessEnv = {},
  ): AcpProcess {
    const id = randomUUID();
    let child: AgentChild;
    try {
      const { command, env } = this.agentLaunch(id, agent, accountEnv);
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
    // 'error' sem 'exit' acontece quando o executável nem sobe (ENOENT): também não há processo para esperar.
    const forget = (): void => {
      this.running.delete(proc);
    };
    child.once('exit', forget);
    child.once('error', forget);
    void exited.then(() => this.agentTokens.revoke(id));
    return { connection: connectAcp(child, handlers), exited, kill: () => killAgent(child) };
  }

  /** Approves a verified YOLO request or waits for the ordinary permission card to be answered. */
  private requestPermission(
    live: LiveSession,
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (!this.isCurrent(live) || signal.aborted || (live.promptInFlight && live.cancelRequested)) {
      return Promise.resolve(cancelled);
    }

    const { id } = live;
    const { toolCall } = request;
    if (live.yolo && live.promptInFlight && live.pending === undefined && request.sessionId === live.acpSessionId) {
      const optionId = yoloApproval(this.workingDirectory(id), request);
      if (optionId !== undefined) {
        const recorded = this.appendEvent(id, {
          kind: 'permission_auto_approved',
          toolCallId: toolCall.toolCallId,
          title: toolCall.title ?? toolCall.name ?? '',
          optionId,
        }, { notify: false });
        if (recorded !== undefined) return Promise.resolve({ outcome: { outcome: 'selected', optionId } });
      }
    }
    // Mesmo tool call pedido de novo com a permissão anterior ainda sem resposta: o aviso dela já saiu. Grava, sem push.
    const reannounced = live.pending?.toolCallId === toolCall.toolCallId;
    // Um agente que pede outra permissão antes de responder a anterior não pode deixar a anterior pendurada.
    this.resolvePermission(live, null);
    const requestId = randomUUID();
    const recorded = this.appendEvent(
      id,
      {
        kind: 'permission_request',
        requestId,
        title: toolCall.title ?? '',
        ...(toolCall.kind ? { toolKind: toolCall.kind } : {}),
        ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
        content: toolContentOf(toolCall.content, this.imageSink(id)),
        options: request.options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
      },
      { notify: !reannounced },
    );
    if (recorded === undefined) return Promise.resolve(cancelled);

    const decision = new Promise<string | null>((resolve) => {
      live.pending = {
        requestId,
        toolCallId: toolCall.toolCallId,
        optionIds: request.options.map((option) => option.optionId),
        resolve,
      };
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
    // A mode the agent announces but Nanachi does not offer for it (omp's plan) is refused before the agent hears of it.
    const isMode = option.type === 'select' && option.category === 'mode';
    if (isMode && typeof value === 'string' && !isModeAllowed(live.agentId, value)) {
      throw new SessionError('invalid_request', `modo indisponível para este agente: ${value}`);
    }
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

  /**
   * Grava as opções que valem agora e avisa quem assina, mas só se mudaram em relação ao banco: opção igual não
   * regrava a linha nem é reenviada.
   */
  private persistConfig(live: LiveSession): void {
    const offered = offeredConfigOptions(live.agentId, live.configOptions);
    if (isDeepStrictEqual(findSessionConfigOptions(this.options.db, live.id), offered)) return;
    updateSession(this.options.db, live.id, { configOptions: offered }, Date.now());
    this.emitConfigOptions(live.id, offered);
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
    if (event.kind === 'agent_message_chunk') this.loops.observeText(sessionId, event.text);
    this.emit(sessionId, event);
    if (options.notify !== false) this.notify(sessionId, event);
    return event;
  }

  /** Loop pausado por falha: aviso de Web Push (`loop_paused`). Erro do handler vai para o log. */
  private notifyLoopFailure(sessionId: string, message: string): void {
    try {
      this.options.onNotify?.(sessionId, 'loop_paused', { kind: 'loop_paused', sessionId, message });
    } catch (error) {
      this.options.log.warn({ err: error, sessionId }, 'aviso de loop pausado falhou');
    }
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

  private emitConfigOptions(sessionId: string, configOptions: SessionConfigOption[]): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener.configOptions(configOptions);
      } catch (error) {
        this.options.log.warn({ err: error, sessionId }, 'assinante de opções falhou');
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
    if (live !== undefined) this.drainPromptQueue(live);
    this.loops.onStatus(sessionId, status);
  }

  private emitLoop(sessionId: string, loop: Loop | null): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener.loop(loop);
      } catch (error) {
        this.options.log.warn({ err: error, sessionId }, 'assinante de loop falhou');
      }
    }
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
    this.options.onSessionRevoked?.(live.id);
    this.userQuestions.cancelSession(live.id);
    this.fileRequests.cancelSession(live.id);
    this.live.delete(live.id);
    if (live.promptQueue.length > 0) this.broadcastPromptQueue(live.id);
    if (live.yolo) this.options.broadcast({ type: 'yolo', sessionId: live.id, enabled: false });
    this.agentTokens.revoke(live.id);
    const pending = live.pending;
    live.pending = undefined;
    pending?.resolve(null);
    this.options.onSessionDetached?.(live.id);
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
