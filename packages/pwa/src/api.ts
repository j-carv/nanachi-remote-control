import {
  AccountLoginCodeRequestSchema,
  AccountLoginStateSchema,
  ActiveAccountResponseSchema,
  AgentAccountsResponseSchema,
  AgentProfileSchema,
  AgentSessionsResponseSchema,
  AgentsResponseSchema,
  AskUserResultSchema,
  AttachmentResponseSchema,
  CommandsResponseSchema,
  CommitRefSchema,
  ConfigOptionsResponseSchema,
  CreateAgentAccountRequestSchema,
  CreateSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  DevicesResponseSchema,
  EventsResponseSchema,
  FsListResponseSchema,
  GitBranchesRepoSchema,
  GitBranchesResponseSchema,
  GitCheckoutRequestSchema,
  HealthResponseSchema,
  LoopRequestSchema,
  LearningSettingsResponseSchema,
  LearningModelsResponseSchema,
  LearningNoticeSchema,
  MemoryEntriesResponseSchema,
  MemoryWriteSchema,
  UpdateLearningSettingsSchema,
  type LearningSettingsResponse,
  type LearningModelsResponse,
  type LearningNotice,
  type MemoryEntry,
  type MemoryWrite,
  type UpdateLearningSettings,
  LoopResponseSchema,
  NanachiMcpResponseSchema,
  PairRequestSchema,
  PairResponseSchema,
  ShellsResponseSchema,
  type ShellsResponse,
  TailscalePairRequestSchema,
  TailscalePairStatusResponseSchema,
  type TailscalePairStatusResponse,
  PushKeyResponseSchema,
  PushSubscriptionRequestSchema,
  PushUnsubscribeRequestSchema,
  RespondUserQuestionRequestSchema,
  RespondFileRequestSchema,
  RequestFileResultSchema,
  PreviewOpenResponseSchema,
  PreviewCloseResponseSchema,
  ResetRedeemRequestSchema,
  ResetRedeemResponseSchema,
  ResetsResponseSchema,
  RenameAgentAccountRequestSchema,
  RootsResponseSchema,
  SessionCommitResponseSchema,
  SessionCommitsResponseSchema,
  SessionDiffResponseSchema,
  SessionSearchQuerySchema,
  SessionSearchResponseSchema,
  ScheduleInputSchema,
  ScheduleTimingSchema,
  ScheduleSchema,
  SchedulesResponseSchema,
  SchedulePreviewResponseSchema,
  ScheduleModelsResponseSchema,
  ScheduleRunSchema,
  ScheduleRunsResponseSchema,
  type Schedule,
  type ScheduleInput,
  type ScheduleModelsResponse,
  type ScheduleRun,
  SessionSchema,
  SessionsResponseSchema,
  SetActiveAccountRequestSchema,
  SetNanachiMcpAgentRequestSchema,
  SetSessionAccountRequestSchema,
  SubmitPromptRequestSchema,
  UpdateWorkspaceRequestSchema,
  UsageResponseSchema,
  WHISPER_MAX_WAV_BYTES,
  TranscriptionLanguageSchema,
  TranscriptionSettingsResponseSchema,
  TranscriptionStatusSchema,
  TranscriptionModelsResponseSchema,
  TranscriptionResultSchema,
  UpdateTranscriptionSettingsSchema,
  WhisperStatusSchema,
  type TranscriptionSettingsResponse,
  type TranscriptionStatus,
  type TranscriptionModelsResponse,
  type TranscriptionResult,
  type UpdateTranscriptionSettings,
  WorkspaceEntriesResponseSchema,
  WorkspaceFileResponseSchema,
  WorkspaceFileWriteRequestSchema,
  WorkspaceFileWriteResponseSchema,
  WorkspaceInfoResponseSchema,
  WorkspaceSchema,
  WorkspacesResponseSchema,
  type AccountLoginState,
  type AgentAccount,
  type AgentProfile,
  type AgentSessionsResponse,
  type AgentsResponse,
  type AttachmentResponse,
  type AskUserResult,
  type RequestFileResult,
  type PreviewOpenResponse,
  type PreviewCloseResponse,
  type AvailableCommand,
  type SessionConfigOption,
  type CreateSessionRequest,
  type CreateWorkspaceRequest,
  type DevicesResponse,
  type FsListResponse,
  type GitBranchesRepo,
  type GitBranchesResponse,
  type GitCheckoutRequest,
  type HealthResponse,
  type Loop,
  type LoopRequest,
  type NanachiMcpResponse,
  type PairResponse,
  type PushSubscriptionRequest,
  type ResetRedeemResponse,
  type ResetsResponse,
  type RootsResponse,
  type Session,
  type SessionCommitResponse,
  type SessionCommitsResponse,
  type SessionDiffResponse,
  type SessionEvent,
  type SessionSearchResult,
  type UpdateWorkspaceRequest,
  type UsageResponse,
  type TranscriptionLanguage,
  type WhisperStatus,
  type Workspace,
  type WorkspaceEntriesResponse,
  type WorkspaceFileResponse,
  type WorkspaceFileWriteRequest,
  type WorkspaceFileWriteResponse,
  type WorkspaceInfoResponse,
} from '@nanachi/shared';
import { z } from 'zod';
import { invalidateAgentAccounts } from './agentAccountsCache.js';
import { normalizeBaseUrl } from './machines.js';
import { blobTypeOf } from './files/blobType.js';

export type ApiErrorKind =
  | 'invalid_input'
  | 'invalid_code'
  | 'unauthorized'
  | 'forbidden'
  | 'outside_roots'
  | 'not_found'
  | 'not_a_directory'
  | 'not_resumable'
  | 'already_running'
  | 'already_linked'
  | 'busy'
  | 'agent_timeout'
  | 'agent_failed'
  | 'too_many_sessions'
  | 'too_large'
  | 'rate_limited'
  | 'not_git'
  | 'no_commits'
  | 'worktree_dirty'
  | 'network'
  | 'unexpected';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Sessão do app ligada ao pedido (vem no 409 de importação: `already_running` / `already_linked`). */
  readonly sessionId: string | null;
  /** `error` of the JSON error body (e.g. `session_busy`), or null. Lets callers tell codes that share a `kind`. */
  readonly code: string | null;
  /** `details` of the JSON error body (e.g. `dirty` for `dirty_worktree`, `etag` for `file_changed`), or null. */
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(
    kind: ApiErrorKind,
    status: number | null = null,
    sessionId: string | null = null,
    code: string | null = null,
    details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(`api error: ${kind}${status === null ? '' : ` (${status})`}`);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.sessionId = sessionId;
    this.code = code;
    this.details = details;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PairInput {
  baseUrl: string;
  code: string;
  deviceName: string;
}

async function send(fetchFn: FetchLike, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch {
    throw new ApiError('network');
  }
}

async function readBody<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError('unexpected', response.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError('unexpected', response.status);
  return parsed.data;
}

/** Pareia este dispositivo com a máquina: `POST {baseUrl}/api/pair`. */
export async function pair(input: PairInput, fetchFn: FetchLike = fetch): Promise<PairResponse> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const request = PairRequestSchema.safeParse({ code: input.code, deviceName: input.deviceName });
  if (baseUrl === null || !request.success) throw new ApiError('invalid_input');

  const response = await send(fetchFn, `${baseUrl}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.data),
  });

  switch (response.status) {
    case 401:
      throw new ApiError('invalid_code', 401);
    case 403:
      throw new ApiError('forbidden', 403);
    case 429:
      throw new ApiError('rate_limited', 429);
  }
  if (!response.ok) throw new ApiError('unexpected', response.status);
  return readBody(response, PairResponseSchema);
}

/**
 * `GET {baseUrl}/api/pair/tailscale` (sem token): o daemon diz se "Entrar com Tailscale" vale para este login.
 * Não disponível é uma resposta normal (`available: false`), não um erro.
 */
export async function pairTailscaleStatus(
  baseUrl: string,
  fetchFn: FetchLike = fetch,
): Promise<TailscalePairStatusResponse> {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized === null) throw new ApiError('invalid_input');

  const response = await send(fetchFn, `${normalized}/api/pair/tailscale`);
  if (!response.ok) throw new ApiError('unexpected', response.status);
  return readBody(response, TailscalePairStatusResponseSchema);
}

export interface TailscalePairInput {
  baseUrl: string;
  deviceName: string;
}

/** `POST {baseUrl}/api/pair/tailscale`: pareia este aparelho sem código. Devolve o mesmo pareamento do código. */
export async function pairTailscale(input: TailscalePairInput, fetchFn: FetchLike = fetch): Promise<PairResponse> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const request = TailscalePairRequestSchema.safeParse({ deviceName: input.deviceName });
  if (baseUrl === null || !request.success) throw new ApiError('invalid_input');

  const response = await send(fetchFn, `${baseUrl}/api/pair/tailscale`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request.data),
  });

  switch (response.status) {
    case 400:
      throw new ApiError('invalid_input', 400);
    case 403:
      throw new ApiError('forbidden', 403);
    case 429:
      throw new ApiError('rate_limited', 429);
  }
  if (!response.ok) throw new ApiError('unexpected', response.status);
  return readBody(response, PairResponseSchema);
}

/** `GET {baseUrl}/api/health` (sem token). */
export async function fetchHealth(
  baseUrl: string,
  fetchFn: FetchLike = fetch,
): Promise<HealthResponse> {
  const normalized = normalizeBaseUrl(baseUrl);
  if (normalized === null) throw new ApiError('invalid_input');

  const response = await send(fetchFn, `${normalized}/api/health`);
  if (response.status === 403) throw new ApiError('forbidden', 403);
  if (!response.ok) throw new ApiError('unexpected', response.status);
  return readBody(response, HealthResponseSchema);
}

/**
 * Handler de evento com assinatura bivariante (truque do React), para que o `XMLHttpRequest`
 * nativo satisfaça `XhrLike` sem adaptador, e os fakes dos testes também.
 */
type Listener<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

export interface UploadProgressEvent {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

/** Subconjunto de `XMLHttpRequest` usado no upload (o progresso do fetch ainda não existe no Safari). */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  upload: { onprogress: Listener<UploadProgressEvent> | null };
  onload: Listener<{ type: string }> | null;
  onerror: Listener<{ type: string }> | null;
  readonly status: number;
  readonly responseText: string;
  send(body: Blob): void;
}

export type XhrFactory = () => XhrLike;

export interface ApiClientOptions {
  baseUrl: string;
  /** Bearer token da máquina (vem do pareamento). */
  token: string;
  /** Fábrica do XHR de upload (injetável para teste). Padrão: `new XMLHttpRequest()`. */
  createXhr?: XhrFactory;
}

/** `removeWorktree`: remove o worktree da sessão ao encerrá-la (sujo → `worktree_dirty`, a sessão para mesmo assim). */
export interface DeleteSessionOptions {
  /** Remove o worktree da sessão (`?removeWorktree=1`). */
  removeWorktree?: boolean;
  /** Remover do app (`?forget=1`): para a sessão e apaga a linha, os eventos e os arquivos dela no PC. O histórico no agente fica. */
  forget?: boolean;
}

/** What the message search asks for. `limit` is 1 to 50 (the daemon's default is 20); `workspaceId` narrows to one workspace. */
export interface SessionSearchInput {
  q: string;
  limit?: number;
  workspaceId?: string;
}

export interface EventsQuery {
  /** Devolve eventos com seq > after. */
  after: number;
  /** 1..500. */
  limit: number;
}

const EventsQuerySchema = z.object({
  after: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(500),
});

/** Id vazio é erro de uso: nem chama a rede. Devolve o id já codificado para a URL. */
function pathId(id: string): string {
  if (id.length === 0) throw new ApiError('invalid_input');
  return encodeURIComponent(id);
}

export interface ApiClient {
  readonly baseUrl: string;
  fetchRoots(): Promise<RootsResponse['roots']>;
  fetchFs(path: string): Promise<FsListResponse>;
  fetchAgents(): Promise<AgentsResponse['agents']>;
  /** Shells que este PC abre para o terminal do workspace (lista vazia se `shellSessions` estiver desligado). */
  fetchShells(): Promise<ShellsResponse['shells']>;
  /** Conta logada em cada agente do config. `refresh` ignora o cache de 5 min do daemon. */
  agentAccounts(refresh: boolean): Promise<AgentAccount[]>;
  /** Opt-in Nanachi MCP preferences for the configured ACP agents on this PC. */
  nanachiMcpAgents(): Promise<NanachiMcpResponse>;
  /** Saves one agent's preference and returns the complete confirmed list. Active sessions are unchanged. */
  setNanachiMcpAgent(agentId: string, enabled: boolean): Promise<NanachiMcpResponse>;
  learningSettings(): Promise<LearningSettingsResponse>;
  saveLearningSettings(input: UpdateLearningSettings): Promise<LearningSettingsResponse>;
  learningModels(): Promise<LearningModelsResponse>;
  listMemories(workspaceId: string, options?: { query?: string; kind?: MemoryEntry['kind']; status?: MemoryEntry['status'] }): Promise<MemoryEntry[]>;
  saveMemory(workspaceId: string, input: MemoryWrite): Promise<MemoryEntry[]>;
  forgetMemory(workspaceId: string, entryId: string, expectedVersion: number): Promise<void>;
  manageLearningReview(workspaceId: string, reviewId: string, action: 'approve' | 'revert'): Promise<LearningNotice>;
  rejectLearningReview(workspaceId: string, reviewId: string): Promise<LearningNotice>;
  /** Adds an account to an agent that supports them (`label`: 1 to 40 characters, trimmed). It starts logged out. */
  createAgentAccount(agentId: string, label: string): Promise<AgentProfile>;
  /** Renames an extra account. The principal (`default`) has no editable name: the daemon answers 400. */
  renameAgentAccount(agentId: string, accountId: string, label: string): Promise<AgentProfile>;
  /** Removes an extra account. 409 `account_in_use` while a session is working on it. */
  deleteAgentAccount(agentId: string, accountId: string): Promise<void>;
  /** The account new sessions of the agent use (`default` = principal). Returns the id the daemon saved. */
  setActiveAgentAccount(agentId: string, accountId: string): Promise<string>;
  /** Starts the login of an account (`default` logs the principal in again). Already running for it: its current state. */
  startAccountLogin(agentId: string, accountId: string): Promise<AccountLoginState>;
  /** State of the account's login. 404 `not_found` when the daemon no longer remembers one. */
  fetchAccountLogin(agentId: string, accountId: string): Promise<AccountLoginState>;
  /** Cancels the running login of the account. */
  cancelAccountLogin(agentId: string, accountId: string): Promise<void>;
  /** Types the code the user pasted into a login that waits for one (Claude). Trimmed here: the daemon does not. */
  sendAccountLoginCode(agentId: string, accountId: string, code: string): Promise<AccountLoginState>;
  /** Moves a session to another account (`default` = principal). 409 `session_busy` while the agent is working. */
  setSessionAccount(sessionId: string, accountId: string): Promise<Session>;
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(input: CreateWorkspaceRequest): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;
  listSessions(workspaceId: string): Promise<Session[]>;
  fetchSession(id: string): Promise<Session>;
  listSchedules(workspaceId: string): Promise<Schedule[]>;
  createSchedule(workspaceId: string, input: ScheduleInput): Promise<Schedule>;
  updateSchedule(workspaceId: string, scheduleId: string, input: ScheduleInput): Promise<Schedule>;
  deleteSchedule(workspaceId: string, scheduleId: string): Promise<void>;
  previewSchedule(workspaceId: string, input: { cronExpression: string; timeZone: string }): Promise<number[]>;
  scheduleModels(workspaceId: string, agentId: string, accountId: string): Promise<ScheduleModelsResponse>;
  runSchedule(workspaceId: string, scheduleId: string): Promise<ScheduleRun>;
  scheduleRuns(workspaceId: string, scheduleId: string): Promise<ScheduleRun[]>;
  scheduleRun(workspaceId: string, scheduleId: string, runId: string): Promise<ScheduleRun>;
  cancelScheduleRun(workspaceId: string, scheduleId: string, runId: string): Promise<ScheduleRun>;
  /**
   * Message search (`GET /api/sessions/search`): sessions whose user or agent messages match every word of `q`, one result
   * each with its newest match. A query outside 2 to 100 characters is `invalid_input` and nothing is sent.
   */
  searchSessions(input: SessionSearchInput): Promise<SessionSearchResult[]>;
  createSession(input: CreateSessionRequest): Promise<Session>;
  submitPrompt(sessionId: string, text: string, attachments: readonly string[]): Promise<void>;
  removeQueuedPrompt(sessionId: string, promptId: string): Promise<void>;
  /** Sobe o agente de uma sessão parada ou com erro (`session/load`). Devolve a sessão atualizada. */
  resumeSession(id: string): Promise<Session>;
  deleteSession(id: string, options?: DeleteSessionOptions): Promise<void>;
  fetchEvents(sessionId: string, query: EventsQuery): Promise<SessionEvent[]>;
  /** Answers this exact pending question; null explicitly cancels. A failed request is never retried automatically. */
  answerUserQuestion(sessionId: string, requestId: string, optionId: string | null): Promise<AskUserResult>;
  respondFileRequest(sessionId: string, requestId: string, fileId: string | null): Promise<RequestFileResult>;
  openPreview(sessionId: string, previewId: string): Promise<PreviewOpenResponse>;
  closePreview(sessionId: string, previewId: string): Promise<PreviewCloseResponse>;
  /** Comandos que o agente anunciou por último (lista vazia se nenhum). */
  sessionCommands(sessionId: string): Promise<AvailableCommand[]>;
  /** Opções de configuração que valem agora (lista vazia se nenhuma). */
  sessionConfigOptions(sessionId: string): Promise<SessionConfigOption[]>;
  /**
   * Usage of the session's agent (`/usage` or `/status`), raw text with ANSI codes; the caller strips them.
   * Writes nothing to the session and does not resume it: a stopped session answers `session_not_active`.
   */
  fetchSessionUsage(sessionId: string): Promise<UsageResponse>;
  /**
   * Saved rate-limit resets of the session's agent (omp and codex only; other agents answer 400 `resets_unsupported`).
   * Read-only: writes nothing to the session and does not resume it.
   */
  getUsageResets(sessionId: string): Promise<ResetsResponse>;
  /**
   * Spends one saved reset (`target` of a row from `getUsageResets`). Irreversible and sent once: it is never retried
   * here. A 504 or a network error means the reset may or may not have been spent; the caller must say so.
   */
  redeemUsageReset(sessionId: string, target: string): Promise<ResetRedeemResponse>;
  /**
   * Envia um arquivo do celular para a sessão (corpo cru, com progresso via XHR).
   * Devolve o arquivo gravado no PC, para ser citado no `prompt`.
   */
  uploadAttachment(
    sessionId: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<AttachmentResponse>;
  /** Baixa um arquivo do PC (`GET /api/files/:id`) como Blob. `mime` é o do arquivo (define o tipo do Blob). */
  fetchFileBlob(fileId: string, mime: string): Promise<Blob>;
  whisperStatus(): Promise<WhisperStatus>;
  installWhisper(): Promise<WhisperStatus>;
  removeWhisper(): Promise<WhisperStatus>;
  transcriptionSettings(): Promise<TranscriptionSettingsResponse>;
  setTranscriptionSettings(input: UpdateTranscriptionSettings): Promise<TranscriptionSettingsResponse>;
  transcriptionStatus(): Promise<TranscriptionStatus>;
  transcriptionModels(): Promise<TranscriptionModelsResponse>;
  transcribeAudio(audio: Blob, language: TranscriptionLanguage, signal: AbortSignal): Promise<TranscriptionResult>;
  updateWorkspace(id: string, input: UpdateWorkspaceRequest): Promise<Workspace>;
  /** Chave pública VAPID da máquina (`publicKey`, base64url). */
  getPushKey(): Promise<string>;
  subscribePush(input: PushSubscriptionRequest): Promise<void>;
  unsubscribePush(endpoint: string): Promise<void>;
  /** Git do workspace: branch, nº de alterações e arquivos de instrução. Não-git: campos null. */
  workspaceInfo(id: string): Promise<WorkspaceInfoResponse>;
  /** Arquivos alterados na sessão (`git diff HEAD`, com patch unificado de cada um). */
  sessionDiff(id: string): Promise<SessionDiffResponse>;
  /** One page of the commits on the session's HEAD, newest first (`skip` and `limit` as the daemon validates them). */
  sessionCommits(id: string, page: { skip: number; limit: number }): Promise<SessionCommitsResponse>;
  /** One commit with its changed files (against its first parent). A `hash` outside the daemon's format is refused here. */
  sessionCommit(id: string, hash: string): Promise<SessionCommitResponse>;
  /**
   * Sessões que o agente tem para a pasta do workspace, para importar (`GET agent-sessions`).
   * `cursor` vem do `nextCursor` da página anterior. `supported: false`: o agente não lista sessões.
   */
  agentSessions(workspaceId: string, agent: string, cursor?: string): Promise<AgentSessionsResponse>;
  /** Dispositivos pareados com a máquina (não revogados). */
  devices(): Promise<DevicesResponse['devices']>;
  revokeDevice(id: string): Promise<void>;
  /** Local branches, the current branch (or the commit when HEAD is detached) and the dirty paths. `isRepo: false` for a plain folder. */
  gitBranches(workspaceId: string): Promise<GitBranchesResponse>;
  /** Switches branch (or creates it with `create`). Same payload as `gitBranches`. Errors carry `code` and `details`. */
  gitCheckout(workspaceId: string, input: GitCheckoutRequest): Promise<GitBranchesRepo>;
  /** Entries of a workspace folder (`path` relative to the root; `""` is the root). Folders first. */
  fsList(workspaceId: string, path: string): Promise<WorkspaceEntriesResponse['entries']>;
  /** UTF-8 content of a text file, with the etag for the next write. */
  fsReadFile(workspaceId: string, path: string): Promise<WorkspaceFileResponse>;
  /** Writes a file. `baseEtag: null` creates it; an etag updates it (409 `file_changed` with `details.etag` if it changed). */
  fsWriteFile(workspaceId: string, input: WorkspaceFileWriteRequest): Promise<WorkspaceFileWriteResponse>;
  /** Creates a folder (not recursive). */
  fsMkdir(workspaceId: string, path: string): Promise<void>;
  /** Renames or moves an entry. */
  fsRename(workspaceId: string, from: string, to: string): Promise<void>;
  /** Deletes a file, a link or an empty folder. */
  fsDelete(workspaceId: string, path: string): Promise<void>;
  /** The session's loop (Loop mode, PLAN.md), or null when it has none. */
  fetchLoop(sessionId: string): Promise<Loop | null>;
  /** Creates or replaces the loop and starts it. `runNow` (the daemon's default is true) runs the first round now. */
  putLoop(sessionId: string, request: LoopRequest): Promise<Loop>;
  pauseLoop(sessionId: string): Promise<Loop>;
  /** Paused → active, with the next round now. A stopped loop answers `loop_finished`. */
  resumeLoop(sessionId: string): Promise<Loop>;
  /** Runs one round now without changing the state (a paused loop stays paused). */
  runLoopNow(sessionId: string): Promise<Loop>;
  /** Stops and deletes the loop. */
  deleteLoop(sessionId: string): Promise<void>;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Código `error` de um corpo JSON de erro, ou null se não houver. */
function codeOf(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return null;
}

/** `details` do corpo de erro (objeto), ou null se não houver. */
function detailsOf(body: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof body !== 'object' || body === null || !('details' in body)) return null;
  const details = body.details;
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? Object.fromEntries(Object.entries(details))
    : null;
}

/** `sessionId` do corpo de erro (409 de importação), ou null se não houver. */
function sessionIdOf(body: unknown): string | null {
  if (typeof body === 'object' && body !== null && 'sessionId' in body && typeof body.sessionId === 'string') {
    return body.sessionId.length > 0 ? body.sessionId : null;
  }
  return null;
}

/** Códigos de erro com tipo próprio, valem qualquer que seja o status (ex.: git 400/409, fs 400). */
const CODED_ERROR_KINDS = new Map<string, ApiErrorKind>([
  ['not_git', 'not_git'],
  ['no_commits', 'no_commits'],
  ['worktree_dirty', 'worktree_dirty'],
  ['not_a_directory', 'not_a_directory'],
]);

/** Erro tipado a partir do status HTTP, do código `error` e do `sessionId` do corpo (se houver). Guarda o código. */
function errorFromStatus(
  status: number,
  code: string | null,
  sessionId: string | null = null,
  details: Readonly<Record<string, unknown>> | null = null,
): ApiError {
  const typed = kindFromStatus(status, code, sessionId);
  return new ApiError(typed.kind, typed.status, typed.sessionId, code, details);
}

function kindFromStatus(status: number, code: string | null, sessionId: string | null): ApiError {
  const coded = code === null ? undefined : CODED_ERROR_KINDS.get(code);
  if (coded !== undefined) return new ApiError(coded, status);

  switch (status) {
    case 400:
      return new ApiError('invalid_input', status);
    case 401:
      return new ApiError('unauthorized', status);
    case 403:
      return new ApiError(code === 'outside_roots' ? 'outside_roots' : 'forbidden', status);
    case 404:
      return new ApiError('not_found', status);
    case 409:
      if (code === 'not_resumable') return new ApiError('not_resumable', status);
      if (code === 'already_running') return new ApiError('already_running', status, sessionId);
      if (code === 'already_linked') return new ApiError('already_linked', status, sessionId);
      if (code === 'busy') return new ApiError('busy', status);
      return new ApiError('unexpected', status);
    case 413:
      return new ApiError('too_large', status);
    case 429:
      if (code === 'too_many_sessions') return new ApiError('too_many_sessions', status);
      if (code === 'busy') return new ApiError('busy', status);
      return new ApiError('rate_limited', status);
    case 502:
      return new ApiError(code === 'agent_failed' ? 'agent_failed' : 'unexpected', status);
    case 504:
      return new ApiError(code === 'agent_timeout' ? 'agent_timeout' : 'unexpected', status);
    default:
      return new ApiError('unexpected', status);
  }
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return errorFromStatus(response.status, codeOf(body), sessionIdOf(body), detailsOf(body));
}

/**
 * Cliente das rotas `/api/*` que exigem Bearer token. Valida entrada (zod do shared)
 * antes de tocar a rede e valida cada resposta. Erros viram `ApiError` com `kind`.
 */
export function createApiClient(options: ApiClientOptions, fetchFn: FetchLike = fetch): ApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (baseUrl === null) throw new ApiError('invalid_input');
  const authorization = `Bearer ${options.token}`;
  const createXhr: XhrFactory = options.createXhr ?? (() => new XMLHttpRequest());

  /** A login that worked adds an account (or makes one logged in): the stored list of accounts is out of date. */
  const connectedLogin = (login: AccountLoginState): AccountLoginState => {
    if (login.state === 'succeeded') invalidateAgentAccounts(baseUrl);
    return login;
  };

  async function call(method: Method, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await send(fetchFn, `${baseUrl}${path}`, init);
    if (response.ok) return response;
    throw await errorFromResponse(response);
  }

  async function getJson<T>(schema: z.ZodType<T>, path: string): Promise<T> {
    return readBody(await call('GET', path), schema);
  }

  async function postJson<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
    return readBody(await call('POST', path, body), schema);
  }

  async function remove(path: string): Promise<void> {
    await call('DELETE', path);
  }

  /** Upload cru via XHR (fetch ainda não reporta progresso de envio). */
  function upload(
    id: string,
    file: File,
    onProgress: (fraction: number) => void,
  ): Promise<AttachmentResponse> {
    return new Promise((resolve, reject) => {
      const xhr = createXhr();
      xhr.open('POST', `${baseUrl}/api/sessions/${id}/attachments`);
      xhr.setRequestHeader('authorization', authorization);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.setRequestHeader('content-type', file.type === '' ? 'application/octet-stream' : file.type);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      };
      xhr.onerror = () => reject(new ApiError('network'));
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          const body = parseJson(xhr.responseText);
          reject(errorFromStatus(xhr.status, codeOf(body), sessionIdOf(body), detailsOf(body)));
          return;
        }
        const parsed = AttachmentResponseSchema.safeParse(parseJson(xhr.responseText));
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError('unexpected', xhr.status));
      };
      xhr.send(file);
    });
  }

  return {
    baseUrl,

    async fetchSession(id) {
      return getJson(SessionSchema, `/api/sessions/${pathId(id)}`);
    },

    async listSchedules(workspaceId) {
      return (await getJson(SchedulesResponseSchema, `/api/workspaces/${pathId(workspaceId)}/schedules`)).schedules;
    },

    async createSchedule(workspaceId, input) {
      const request = ScheduleInputSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return postJson(ScheduleSchema, `/api/workspaces/${pathId(workspaceId)}/schedules`, request.data);
    },

    async updateSchedule(workspaceId, scheduleId, input) {
      const request = ScheduleInputSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return readBody(
        await call('PUT', `/api/workspaces/${pathId(workspaceId)}/schedules/${pathId(scheduleId)}`, request.data),
        ScheduleSchema,
      );
    },

    async deleteSchedule(workspaceId, scheduleId) {
      await remove(`/api/workspaces/${pathId(workspaceId)}/schedules/${pathId(scheduleId)}`);
    },

    async previewSchedule(workspaceId, input) {
      const request = ScheduleTimingSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return (await postJson(
        SchedulePreviewResponseSchema, `/api/workspaces/${pathId(workspaceId)}/schedules/preview`, request.data,
      )).nextRuns;
    },

    async scheduleModels(workspaceId, agentId, accountId) {
      const request = z.object({
        agentId: z.string().min(1).max(200),
        accountId: z.string().min(1).max(200),
      }).safeParse({ agentId, accountId });
      if (!request.success) throw new ApiError('invalid_input');
      const query = new URLSearchParams(request.data).toString();
      return getJson(ScheduleModelsResponseSchema, `/api/workspaces/${pathId(workspaceId)}/schedules/models?${query}`);
    },

    async runSchedule(workspaceId, scheduleId) {
      return postJson(ScheduleRunSchema, `/api/workspaces/${pathId(workspaceId)}/schedules/${pathId(scheduleId)}/run`, undefined);
    },

    async scheduleRuns(workspaceId, scheduleId) {
      return (await getJson(
        ScheduleRunsResponseSchema, `/api/workspaces/${pathId(workspaceId)}/schedules/${pathId(scheduleId)}/runs`,
      )).runs;
    },

    async scheduleRun(workspaceId, scheduleId, runId) {
      return getJson(
        ScheduleRunSchema, `/api/workspaces/${pathId(workspaceId)}/schedules/${pathId(scheduleId)}/runs/${pathId(runId)}`,
      );
    },

    async cancelScheduleRun(workspaceId, scheduleId, runId) {
      return postJson(
        ScheduleRunSchema,
        `/api/workspaces/${pathId(workspaceId)}/schedules/${pathId(scheduleId)}/runs/${pathId(runId)}/cancel`,
        undefined,
      );
    },

    async learningSettings() {
      return getJson(LearningSettingsResponseSchema, '/api/learning/settings');
    },

    async saveLearningSettings(input) {
      const request = UpdateLearningSettingsSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return readBody(await call('PUT', '/api/learning/settings', request.data), LearningSettingsResponseSchema);
    },

    async learningModels() {
      return getJson(LearningModelsResponseSchema, '/api/learning/models');
    },

    async listMemories(workspaceId, options = {}) {
      const query = new URLSearchParams();
      if (options.query !== undefined) query.set('query', options.query);
      if (options.kind !== undefined) query.set('kind', options.kind);
      if (options.status !== undefined) query.set('status', options.status);
      const suffix = query.size > 0 ? `?${query}` : '';
      return (await getJson(MemoryEntriesResponseSchema, `/api/workspaces/${pathId(workspaceId)}/memories${suffix}`)).entries;
    },

    async saveMemory(workspaceId, input) {
      const request = MemoryWriteSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return (await postJson(MemoryEntriesResponseSchema, `/api/workspaces/${pathId(workspaceId)}/memories`, request.data)).entries;
    },

    async forgetMemory(workspaceId, entryId, expectedVersion) {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new ApiError('invalid_input');
      await readBody(await call('DELETE', `/api/workspaces/${pathId(workspaceId)}/memories/${pathId(entryId)}`, { expectedVersion }), MemoryEntriesResponseSchema);
    },

    async manageLearningReview(workspaceId, reviewId, action) {
      return postJson(LearningNoticeSchema, `/api/workspaces/${pathId(workspaceId)}/learning/${pathId(reviewId)}/${action}`, {});
    },

    async rejectLearningReview(workspaceId, reviewId) {
      return postJson(LearningNoticeSchema, `/api/workspaces/${pathId(workspaceId)}/learning/${pathId(reviewId)}/reject`, {});
    },

    async fetchRoots() {
      const { roots } = await getJson(RootsResponseSchema, '/api/roots');
      return roots;
    },

    async fetchFs(path) {
      if (path.length === 0) throw new ApiError('invalid_input');
      const query = new URLSearchParams({ path }).toString();
      return getJson(FsListResponseSchema, `/api/fs?${query}`);
    },

    async fetchAgents() {
      const { agents } = await getJson(AgentsResponseSchema, '/api/agents');
      return agents;
    },

    async fetchShells() {
      const { shells } = await getJson(ShellsResponseSchema, '/api/shells');
      return shells;
    },

    async agentAccounts(refresh) {
      const query = refresh ? '?refresh=1' : '';
      const { accounts } = await getJson(AgentAccountsResponseSchema, `/api/agents/accounts${query}`);
      return accounts;
    },

    async nanachiMcpAgents() {
      return getJson(NanachiMcpResponseSchema, '/api/mcp/agents');
    },

    async setNanachiMcpAgent(agentId, enabled) {
      const request = SetNanachiMcpAgentRequestSchema.safeParse({ enabled });
      if (!request.success) throw new ApiError('invalid_input');
      return readBody(
        await call('PUT', `/api/mcp/agents/${pathId(agentId)}`, request.data),
        NanachiMcpResponseSchema,
      );
    },

    async createAgentAccount(agentId, label) {
      const request = CreateAgentAccountRequestSchema.safeParse({ label });
      if (!request.success) throw new ApiError('invalid_input');
      try {
        return await postJson(AgentProfileSchema, `/api/agents/${pathId(agentId)}/accounts`, request.data);
      } finally {
        invalidateAgentAccounts(baseUrl);
      }
    },

    async renameAgentAccount(agentId, accountId, label) {
      const request = RenameAgentAccountRequestSchema.safeParse({ label });
      if (!request.success) throw new ApiError('invalid_input');
      try {
        return await readBody(
          await call('PATCH', `/api/agents/${pathId(agentId)}/accounts/${pathId(accountId)}`, request.data),
          AgentProfileSchema,
        );
      } finally {
        invalidateAgentAccounts(baseUrl);
      }
    },

    async deleteAgentAccount(agentId, accountId) {
      try {
        await remove(`/api/agents/${pathId(agentId)}/accounts/${pathId(accountId)}`);
      } finally {
        invalidateAgentAccounts(baseUrl);
      }
    },

    async setActiveAgentAccount(agentId, accountId) {
      const request = SetActiveAccountRequestSchema.safeParse({ accountId });
      if (!request.success) throw new ApiError('invalid_input');
      try {
        const saved = await readBody(
          await call('PUT', `/api/agents/${pathId(agentId)}/accounts/active`, request.data),
          ActiveAccountResponseSchema,
        );
        return saved.accountId;
      } finally {
        invalidateAgentAccounts(baseUrl);
      }
    },

    async startAccountLogin(agentId, accountId) {
      return connectedLogin(
        await postJson(
          AccountLoginStateSchema,
          `/api/agents/${pathId(agentId)}/accounts/${pathId(accountId)}/login`,
          undefined,
        ),
      );
    },

    async fetchAccountLogin(agentId, accountId) {
      return connectedLogin(
        await getJson(AccountLoginStateSchema, `/api/agents/${pathId(agentId)}/accounts/${pathId(accountId)}/login`),
      );
    },

    async cancelAccountLogin(agentId, accountId) {
      await remove(`/api/agents/${pathId(agentId)}/accounts/${pathId(accountId)}/login`);
    },

    async sendAccountLoginCode(agentId, accountId, code) {
      // The daemon types the code as it arrives, so a pasted trailing space or newline would break it.
      const request = AccountLoginCodeRequestSchema.safeParse({ code: code.trim() });
      if (!request.success) throw new ApiError('invalid_input');
      return connectedLogin(
        await postJson(
          AccountLoginStateSchema,
          `/api/agents/${pathId(agentId)}/accounts/${pathId(accountId)}/login/code`,
          request.data,
        ),
      );
    },

    async setSessionAccount(sessionId, accountId) {
      const request = SetSessionAccountRequestSchema.safeParse({ accountId });
      if (!request.success) throw new ApiError('invalid_input');
      return readBody(await call('PUT', `/api/sessions/${pathId(sessionId)}/account`, request.data), SessionSchema);
    },

    async listWorkspaces() {
      const { workspaces } = await getJson(WorkspacesResponseSchema, '/api/workspaces');
      return workspaces;
    },

    async createWorkspace(input) {
      const request = CreateWorkspaceRequestSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return postJson(WorkspaceSchema, '/api/workspaces', request.data);
    },

    async deleteWorkspace(id) {
      await remove(`/api/workspaces/${pathId(id)}`);
    },

    async listSessions(workspaceId) {
      const id = pathId(workspaceId);
      const { sessions } = await getJson(SessionsResponseSchema, `/api/workspaces/${id}/sessions`);
      return sessions;
    },

    async searchSessions(input) {
      const request = SessionSearchQuerySchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      const params = new URLSearchParams({ q: request.data.q, limit: String(request.data.limit) });
      if (request.data.workspaceId !== undefined) params.set('workspaceId', request.data.workspaceId);
      const { results } = await getJson(SessionSearchResponseSchema, `/api/sessions/search?${params}`);
      return results;
    },

    async createSession(input) {
      const request = CreateSessionRequestSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return postJson(SessionSchema, '/api/sessions', request.data);
    },

    async submitPrompt(sessionId, text, attachments) {
      const request = SubmitPromptRequestSchema.safeParse({ text: text.trim(), attachments });
      if (!request.success) throw new ApiError('invalid_input');
      await call('POST', `/api/sessions/${pathId(sessionId)}/queue`, request.data);
    },

    async removeQueuedPrompt(sessionId, promptId) {
      await remove(`/api/sessions/${pathId(sessionId)}/queue/${pathId(promptId)}`);
    },

    async agentSessions(workspaceId, agent, cursor) {
      const id = pathId(workspaceId);
      const params = new URLSearchParams({ agent });
      if (cursor !== undefined) params.set('cursor', cursor);
      return getJson(AgentSessionsResponseSchema, `/api/workspaces/${id}/agent-sessions?${params}`);
    },

    async resumeSession(id) {
      return postJson(SessionSchema, `/api/sessions/${pathId(id)}/resume`, undefined);
    },

    async deleteSession(id, options = {}) {
      const params = new URLSearchParams();
      if (options.removeWorktree === true) params.set('removeWorktree', '1');
      if (options.forget === true) params.set('forget', '1');
      const query = params.size > 0 ? `?${params.toString()}` : '';
      await remove(`/api/sessions/${pathId(id)}${query}`);
    },

    async sessionCommands(sessionId) {
      const { commands } = await getJson(CommandsResponseSchema, `/api/sessions/${pathId(sessionId)}/commands`);
      return commands;
    },

    async sessionConfigOptions(sessionId) {
      const { configOptions } = await getJson(ConfigOptionsResponseSchema, `/api/sessions/${pathId(sessionId)}/config`);
      return configOptions;
    },

    async fetchSessionUsage(sessionId) {
      return postJson(UsageResponseSchema, `/api/sessions/${pathId(sessionId)}/usage`, undefined);
    },

    async getUsageResets(sessionId) {
      return getJson(ResetsResponseSchema, `/api/sessions/${pathId(sessionId)}/usage/resets`);
    },

    async redeemUsageReset(sessionId, target) {
      const request = ResetRedeemRequestSchema.safeParse({ target });
      if (!request.success) throw new ApiError('invalid_input');
      return postJson(ResetRedeemResponseSchema, `/api/sessions/${pathId(sessionId)}/usage/resets`, request.data);
    },

    async fetchEvents(sessionId, query) {
      const parsed = EventsQuerySchema.safeParse(query);
      if (!parsed.success) throw new ApiError('invalid_input');
      const id = pathId(sessionId);
      const params = new URLSearchParams({
        after: String(parsed.data.after),
        limit: String(parsed.data.limit),
      });
      const { events } = await getJson(EventsResponseSchema, `/api/sessions/${id}/events?${params}`);
      return events;
    },

    async answerUserQuestion(sessionId, requestId, optionId) {
      const request = RespondUserQuestionRequestSchema.safeParse({ optionId });
      if (!request.success) throw new ApiError('invalid_input');
      const response = await send(
        fetchFn,
        `${baseUrl}/api/sessions/${pathId(sessionId)}/questions/${pathId(requestId)}/respond`,
        {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify(request.data),
          // An unavailable PC must not leave the choices locked indefinitely, even if the WebSocket also drops.
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) throw await errorFromResponse(response);
      return readBody(response, AskUserResultSchema);
    },

    async respondFileRequest(sessionId, requestId, fileId) {
      const request = RespondFileRequestSchema.safeParse({ fileId });
      if (!request.success) throw new ApiError('invalid_input');
      const response = await send(fetchFn, `${baseUrl}/api/sessions/${pathId(sessionId)}/file-requests/${pathId(requestId)}/respond`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(request.data),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw await errorFromResponse(response);
      return readBody(response, RequestFileResultSchema);
    },

    async openPreview(sessionId, previewId) {
      const response = await send(fetchFn, `${baseUrl}/api/sessions/${pathId(sessionId)}/previews/${pathId(previewId)}/open`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw await errorFromResponse(response);
      return readBody(response, PreviewOpenResponseSchema);
    },

    async closePreview(sessionId, previewId) {
      return readBody(await call('DELETE', `/api/sessions/${pathId(sessionId)}/previews/${pathId(previewId)}`), PreviewCloseResponseSchema);
    },

    async uploadAttachment(sessionId, file, onProgress) {
      return upload(pathId(sessionId), file, onProgress);
    },

    async fetchFileBlob(fileId, mime) {
      const response = await call('GET', `/api/files/${pathId(fileId)}`);
      try {
        return new Blob([await response.arrayBuffer()], { type: blobTypeOf(mime) });
      } catch {
        throw new ApiError('network', response.status);
      }
    },

    whisperStatus: () => getJson(WhisperStatusSchema, '/api/whisper'),

    async installWhisper() {
      return readBody(await call('POST', '/api/whisper/install'), WhisperStatusSchema);
    },

    async removeWhisper() {
      return readBody(await call('DELETE', '/api/whisper'), WhisperStatusSchema);
    },

    transcriptionSettings: () => getJson(TranscriptionSettingsResponseSchema, '/api/transcription/settings'),
    transcriptionStatus: () => getJson(TranscriptionStatusSchema, '/api/transcription/status'),
    transcriptionModels: () => getJson(TranscriptionModelsResponseSchema, '/api/transcription/models'),

    async setTranscriptionSettings(input) {
      const request = UpdateTranscriptionSettingsSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return readBody(await call('PUT', '/api/transcription/settings', request.data), TranscriptionSettingsResponseSchema);
    },

    async transcribeAudio(audio, language, signal) {
      const parsed = TranscriptionLanguageSchema.safeParse(language);
      if (!parsed.success || audio.type !== 'audio/wav' || audio.size > WHISPER_MAX_WAV_BYTES) {
        throw new ApiError('invalid_input');
      }
      const response = await send(fetchFn, `${baseUrl}/api/transcription/transcribe?language=${parsed.data}`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'audio/wav' },
        body: audio,
        signal,
      });
      if (!response.ok) throw await errorFromResponse(response);
      return readBody(response, TranscriptionResultSchema);
    },

    async updateWorkspace(id, input) {
      const request = UpdateWorkspaceRequestSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return readBody(
        await call('PATCH', `/api/workspaces/${pathId(id)}`, request.data),
        WorkspaceSchema,
      );
    },

    async getPushKey() {
      const { publicKey } = await getJson(PushKeyResponseSchema, '/api/push/key');
      return publicKey;
    },

    async subscribePush(input) {
      const request = PushSubscriptionRequestSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      await call('POST', '/api/push/subscribe', request.data);
    },

    async unsubscribePush(endpoint) {
      const request = PushUnsubscribeRequestSchema.safeParse({ endpoint });
      if (!request.success) throw new ApiError('invalid_input');
      await call('DELETE', '/api/push/subscribe', request.data);
    },

    async workspaceInfo(id) {
      return getJson(WorkspaceInfoResponseSchema, `/api/workspaces/${pathId(id)}/info`);
    },

    async sessionDiff(id) {
      return getJson(SessionDiffResponseSchema, `/api/sessions/${pathId(id)}/diff`);
    },

    async sessionCommits(id, page) {
      const query = new URLSearchParams({ skip: String(page.skip), limit: String(page.limit) }).toString();
      return getJson(SessionCommitsResponseSchema, `/api/sessions/${pathId(id)}/commits?${query}`);
    },

    async sessionCommit(id, hash) {
      const ref = CommitRefSchema.safeParse(hash);
      if (!ref.success) throw new ApiError('invalid_input');
      return getJson(SessionCommitResponseSchema, `/api/sessions/${pathId(id)}/commits/${ref.data}`);
    },

    async devices() {
      const { devices } = await getJson(DevicesResponseSchema, '/api/devices');
      return devices;
    },

    async revokeDevice(id) {
      await remove(`/api/devices/${pathId(id)}`);
    },

    async gitBranches(workspaceId) {
      return getJson(GitBranchesResponseSchema, `/api/workspaces/${pathId(workspaceId)}/git/branches`);
    },

    async gitCheckout(workspaceId, input) {
      const request = GitCheckoutRequestSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return postJson(GitBranchesRepoSchema, `/api/workspaces/${pathId(workspaceId)}/git/checkout`, request.data);
    },

    async fsList(workspaceId, path) {
      const query = new URLSearchParams({ path }).toString();
      const { entries } = await getJson(
        WorkspaceEntriesResponseSchema,
        `/api/workspaces/${pathId(workspaceId)}/fs/list?${query}`,
      );
      return entries;
    },

    async fsReadFile(workspaceId, path) {
      const query = new URLSearchParams({ path }).toString();
      return getJson(WorkspaceFileResponseSchema, `/api/workspaces/${pathId(workspaceId)}/fs/file?${query}`);
    },

    async fsWriteFile(workspaceId, input) {
      const request = WorkspaceFileWriteRequestSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return readBody(
        await call('PUT', `/api/workspaces/${pathId(workspaceId)}/fs/file`, request.data),
        WorkspaceFileWriteResponseSchema,
      );
    },

    async fsMkdir(workspaceId, path) {
      await call('POST', `/api/workspaces/${pathId(workspaceId)}/fs/mkdir`, { path });
    },

    async fsRename(workspaceId, from, to) {
      await call('POST', `/api/workspaces/${pathId(workspaceId)}/fs/rename`, { from, to });
    },

    async fsDelete(workspaceId, path) {
      const query = new URLSearchParams({ path }).toString();
      await remove(`/api/workspaces/${pathId(workspaceId)}/fs/entry?${query}`);
    },

    async fetchLoop(sessionId) {
      const { loop } = await getJson(LoopResponseSchema, `/api/sessions/${pathId(sessionId)}/loop`);
      return loop;
    },

    async putLoop(sessionId, input) {
      const request = LoopRequestSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return loopFrom(await call('PUT', `/api/sessions/${pathId(sessionId)}/loop`, request.data));
    },

    async pauseLoop(sessionId) {
      return loopFrom(await call('POST', `/api/sessions/${pathId(sessionId)}/loop/pause`));
    },

    async resumeLoop(sessionId) {
      return loopFrom(await call('POST', `/api/sessions/${pathId(sessionId)}/loop/resume`));
    },

    async runLoopNow(sessionId) {
      return loopFrom(await call('POST', `/api/sessions/${pathId(sessionId)}/loop/run-now`));
    },

    async deleteLoop(sessionId) {
      await remove(`/api/sessions/${pathId(sessionId)}/loop`);
    },
  };
}

/** The loop of a response that must carry one (PUT and the actions). `loop: null` here is an unexpected response. */
async function loopFrom(response: Response): Promise<Loop> {
  const { loop } = await readBody(response, LoopResponseSchema);
  if (loop === null) throw new ApiError('unexpected', response.status);
  return loop;
}

/** JSON de um texto, ou undefined se não for JSON (o chamador valida com schema). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
