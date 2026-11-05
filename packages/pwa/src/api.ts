import {
  AgentAccountsResponseSchema,
  AgentSessionsResponseSchema,
  AgentsResponseSchema,
  AttachmentResponseSchema,
  CommandsResponseSchema,
  ConfigOptionsResponseSchema,
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
  LoopResponseSchema,
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
  RootsResponseSchema,
  SessionDiffResponseSchema,
  SessionSchema,
  SessionsResponseSchema,
  UpdateWorkspaceRequestSchema,
  UsageResponseSchema,
  WorkspaceEntriesResponseSchema,
  WorkspaceFileResponseSchema,
  WorkspaceFileWriteRequestSchema,
  WorkspaceFileWriteResponseSchema,
  WorkspaceInfoResponseSchema,
  WorkspaceSchema,
  WorkspacesResponseSchema,
  type AgentAccount,
  type AgentSessionsResponse,
  type AgentsResponse,
  type AttachmentResponse,
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
  type PairResponse,
  type PushSubscriptionRequest,
  type RootsResponse,
  type Session,
  type SessionDiffResponse,
  type SessionEvent,
  type UpdateWorkspaceRequest,
  type UsageResponse,
  type Workspace,
  type WorkspaceEntriesResponse,
  type WorkspaceFileResponse,
  type WorkspaceFileWriteRequest,
  type WorkspaceFileWriteResponse,
  type WorkspaceInfoResponse,
} from '@nanachi/shared';
import { z } from 'zod';
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
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(input: CreateWorkspaceRequest): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;
  listSessions(workspaceId: string): Promise<Session[]>;
  createSession(input: CreateSessionRequest): Promise<Session>;
  /** Sobe o agente de uma sessão parada ou com erro (`session/load`). Devolve a sessão atualizada. */
  resumeSession(id: string): Promise<Session>;
  deleteSession(id: string, options?: DeleteSessionOptions): Promise<void>;
  fetchEvents(sessionId: string, query: EventsQuery): Promise<SessionEvent[]>;
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
  updateWorkspace(id: string, input: UpdateWorkspaceRequest): Promise<Workspace>;
  /** Chave pública VAPID da máquina (`publicKey`, base64url). */
  getPushKey(): Promise<string>;
  subscribePush(input: PushSubscriptionRequest): Promise<void>;
  unsubscribePush(endpoint: string): Promise<void>;
  /** Git do workspace: branch, nº de alterações e arquivos de instrução. Não-git: campos null. */
  workspaceInfo(id: string): Promise<WorkspaceInfoResponse>;
  /** Arquivos alterados na sessão (`git diff HEAD`, com patch unificado de cada um). */
  sessionDiff(id: string): Promise<SessionDiffResponse>;
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

    async createSession(input) {
      const request = CreateSessionRequestSchema.safeParse(input);
      if (!request.success) throw new ApiError('invalid_input');
      return postJson(SessionSchema, '/api/sessions', request.data);
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
