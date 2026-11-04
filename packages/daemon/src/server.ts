import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  CreateSessionRequestSchema,
  CreateWorkspaceRequestSchema,
  PairRequestSchema,
  parseClientMessage,
  PushSubscriptionRequestSchema,
  PushUnsubscribeRequestSchema,
  UpdateWorkspaceRequestSchema,
  type AgentAccountsResponse,
  type AgentSessionsResponse,
  type CommandsResponse,
  type ConfigOptionsResponse,
  type AgentsResponse,
  type ClientMessage,
  type DevicesResponse,
  type EventsResponse,
  type FsListResponse,
  type HealthResponse,
  type MeResponse,
  type PairResponse,
  type PushKeyResponse,
  type RootsResponse,
  type ServerMessage,
  type Session,
  type SessionDiffResponse,
  type SessionEvent,
  type SessionsResponse,
  type Workspace,
  type WorkspaceInfoResponse,
  type WorkspacesResponse,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { WebSocket, type RawData } from 'ws';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createAgentAccounts, type AgentAccountsService } from './agent-accounts.js';
import { agentBinDirs, withPathPrepended } from './agent-path.js';
import type { LoadedConfig } from './config.js';
import { registerFileRoutes } from './file-routes.js';
import { FileQuotaError, filesRootOf, removeSessionFiles } from './files.js';
import { createHostCheck } from './host-check.js';
import { isAllowedPushEndpoint } from './push-endpoint.js';
import { LiveConnections } from './live-connections.js';
import { serializeRequest } from './log.js';
import { sessionDiff } from './session-diff.js';
import { authenticateToken, pairDevice } from './pairing.js';
import type { NotifyHandler } from './notify.js';
import { replayEvents } from './replay.js';
import { createFailureLimiter } from './rate-limit.js';
import {
  deletePushSubscription,
  deleteWorkspace,
  findPushSubscriptionOwner,
  findSessionById,
  findSessionCommands,
  findSessionConfigOptions,
  findWorkspaceById,
  findWorkspaceByPath,
  insertWorkspace,
  listActiveDevices,
  listEvents,
  listSessionsByWorkspace,
  listWorkspaces,
  revokeDevice,
  setWorkspaceMuted,
  upsertPushSubscription,
  type DeviceRow,
  type Machine,
} from './repository.js';
import { describeRoots, listDirectory, PathError, resolveInsideRoots, type PathErrorCode } from './roots.js';
import { resumeAfterReload } from './reload-resume.js';
import { SessionError, SessionManager, type SessionErrorCode } from './session-manager.js';
import { isAllowedWsOrigin } from './ws-origin.js';
import { workspaceInfo } from './workspace-info.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Dispositivo do Bearer. Preenchido no preHandler das rotas `/api` (depois dele, nunca é null). */
    device: DeviceRow | null;
  }
}

/** Chamado depois que um workspace sai do banco. `sessionIds` são as sessões que deixaram de estar ativas. */
export type WorkspaceDeletedHandler = (event: { workspaceId: string; sessionIds: string[] }) => void | Promise<void>;

export interface ServerDeps {
  config: LoadedConfig;
  db: Database.Database;
  machine: Machine;
  version: string;
  /** `<NANACHI_HOME>`: arquivos ficam em `<home>/files`. */
  home: string;
  /** Pasta com o build do PWA (index.html + assets). Pode não existir. */
  staticDir: string;
  /** Chave pública VAPID (`GET /api/push/key`). Vem do `vapid.json` carregado na subida. */
  vapidPublicKey: string;
  /** Aviso para turn_end, permission_request, error e file. Opcional: sem ele, nada acontece. */
  onNotify?: NotifyHandler | undefined;
  /**
   * WS abertos por device. Quem vai mandar push precisa do mesmo registro para saber quem está online.
   * Padrão: um registro novo, privado do server.
   */
  connections?: LiveConnections | undefined;
  /** Padrão: true (logs info). Testes passam false. */
  logger?: boolean;
  /** Ponto de extensão para quem precisa reagir a um workspace apagado (além de parar as sessões dele). */
  onWorkspaceDeleted?: WorkspaceDeletedHandler | undefined;
  /** Intervalo em que cada WS aberto revalida o dispositivo. Padrão: 30 s. Testes usam valor curto. */
  wsRevalidateMs?: number | undefined;
  /** Teto da listagem de sessões do agente (`agent-sessions`). Padrão: 30 s. Testes usam valor curto. */
  agentListTimeoutMs?: number | undefined;
  /** Contas dos agentes (`GET /api/agents/accounts`). Padrão: verificadores reais sobre o PATH dos agentes. */
  agentAccounts?: AgentAccountsService | undefined;
  /** Sessões que o reload deixou ociosas (`reload-resume.ts`): retomadas em segundo plano assim que o servidor escuta. */
  resumeAfterReload?: readonly string[] | undefined;
}

/** Status HTTP de cada erro de caminho. */
const PATH_ERROR_STATUS: Record<PathErrorCode, number> = {
  outside_roots: 403,
  not_found: 404,
  not_a_directory: 400,
};

/** Status HTTP de cada erro de sessão. */
const SESSION_ERROR_STATUS: Record<SessionErrorCode, number> = {
  not_found: 404,
  unknown_agent: 400,
  invalid_request: 400,
  session_busy: 409,
  too_many_sessions: 429,
  already_running: 409,
  already_linked: 409,
  busy: 429,
  agent_timeout: 504,
  agent_failed: 502,
  not_resumable: 409,
  not_acp: 409,
  not_pty: 409,
  not_git: 400,
  no_commits: 400,
  worktree_failed: 500,
  worktree_dirty: 409,
};

const PAIR_MAX_FAILURES = 5;
const PAIR_FAILURE_WINDOW_MS = 60_000;
/** Código de fechamento do WS para token ausente, inválido ou revogado. */
const WS_UNAUTHORIZED = 4401;
const EVENTS_DEFAULT_LIMIT = 200;
const EVENTS_MAX_LIMIT = 500;
/** Teto de tamanho de uma mensagem do cliente no WS (1 MiB). Acima disso o socket é fechado com 1009. */
const WS_MAX_PAYLOAD_BYTES = 1_048_576;
/** Cada WS aberto revalida o dispositivo nesse intervalo, além de a cada mensagem recebida. */
const WS_REVALIDATE_MS = 30_000;

function pathOf(url: string): string {
  return url.split('?', 1)[0] ?? '';
}

/** Base que o agente usa em `NANACHI_URL`: o endereço real quando o servidor está no ar, senão o do config. */
function agentBaseUrl(app: FastifyInstance, config: LoadedConfig): string {
  const address = app.server.address();
  if (address !== null && typeof address === 'object') {
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
  }
  const host = config.host === '::1' ? '[::1]' : '127.0.0.1';
  return `http://${host}:${config.port}`;
}

function isApiPath(url: string): boolean {
  const path = pathOf(url);
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Rotas que passam pela checagem Tailscale. `/api/agent/*` fica de fora: o agente chama o daemon em loopback,
 * sem `tailscale serve`, e a rota é protegida pelo token de sessão.
 */
function isProtectedPath(url: string): boolean {
  if (pathOf(url).startsWith('/api/agent/')) return false;
  return isApiPath(url) || pathOf(url) === '/ws';
}

/** Status HTTP de erros do próprio Fastify (corpo JSON inválido, 415, 413...). */
function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  return undefined;
}

/** Socket TLS (daemon exposto direto com https). `injectWS` não tem socket: nesse caso é false. */
function isTlsSocket(socket: unknown): boolean {
  return typeof socket === 'object' && socket !== null && 'encrypted' in socket && socket.encrypted === true;
}

/** Header como texto: repetido (array) ou ausente vira undefined. */
function headerText(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function send(socket: WebSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}

/** Query numérica opcional: ausente → fallback; fora de [min, max] ou não-inteira → undefined (400). */
function parseIntParam(value: unknown, options: { fallback: number; min: number; max: number }): number | undefined {
  if (value === undefined) return options.fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= options.min && parsed <= options.max ? parsed : undefined;
}

/** Inscrições de um socket: sessionId → função que cancela a assinatura. */
type Subscriptions = Map<string, () => void>;

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, db, machine, version, home, staticDir, onWorkspaceDeleted, onNotify, vapidPublicKey } = deps;
  const connections = deps.connections ?? new LiveConnections();
  const filesRoot = resolve(filesRootOf(home));
  const wsRevalidateMs = deps.wsRevalidateMs ?? WS_REVALIDATE_MS;
  const app = Fastify({
    logger: deps.logger === false ? false : { level: 'info', serializers: { req: serializeRequest } },
  });

  const broadcast = (message: ServerMessage): void => {
    for (const socket of connections.all()) {
      if (socket.readyState === WebSocket.OPEN) send(socket, message);
    }
  };
  const sessions = new SessionManager({
    db,
    config,
    log: app.log,
    broadcast,
    agentApiUrl: () => agentBaseUrl(app, config),
    worktreesRoot: join(home, 'worktrees'),
    filesRoot,
    onNotify,
    agentListTimeoutMs: deps.agentListTimeoutMs,
  });
  const agentAccounts =
    deps.agentAccounts ??
    createAgentAccounts({
      agents: config.agents,
      env: withPathPrepended({ ...process.env }, agentBinDirs()),
    });
  // Ao fechar o daemon, os agentes morrem junto (antes do banco ser fechado pelo main).
  app.addHook('onClose', async () => {
    await sessions.shutdown();
  });
  // Retomada depois do reload: em segundo plano, sem atrasar a subida; falha de uma sessão só vira aviso.
  const resumeIds = deps.resumeAfterReload ?? [];
  if (resumeIds.length > 0) {
    app.addHook('onListen', async () => {
      void resumeAfterReload(resumeIds, {
        resume: (sessionId) => sessions.resume(sessionId, { markStarting: true }),
        log: app.log,
      });
    });
  }

  // Erros viram { error: "<codigo>" }: caminho -> 403/404/400; sessão -> 400/404/409; corpo inválido do cliente -> 400; resto -> 500.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof PathError) {
      return reply.code(PATH_ERROR_STATUS[error.code]).send({ error: error.code });
    }
    if (error instanceof SessionError) {
      return reply.code(SESSION_ERROR_STATUS[error.code]).send({ error: error.code, ...error.details });
    }
    if (error instanceof FileQuotaError) {
      return reply.code(413).send({ error: 'quota_exceeded' });
    }
    const statusCode = statusCodeOf(error);
    if (statusCode === 413) {
      return reply.code(413).send({ error: 'too_large' });
    }
    if (statusCode !== undefined && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'invalid_request' });
    }
    request.log.error({ err: error }, 'erro não tratado');
    return reply.code(500).send({ error: 'internal_error' });
  });

  // Antes dos hooks de acesso: o plugin marca `request.ws` em onRequest, e o onResponse só fecha o socket
  // do upgrade recusado (403) se essa marca existir. Hook que responde antes dele deixaria o socket aberto.
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } });

  // Anti DNS rebinding: todo request (e o upgrade do WS) precisa de Host de loopback, ts.net ou de corsOrigins.
  const hostAllowed = createHostCheck(config.corsOrigins);
  app.addHook('onRequest', async (request, reply) => {
    const allowed = hostAllowed({
      host: headerText(request.headers.host),
      forwardedHost: headerText(request.headers['x-forwarded-host']),
    });
    if (!allowed) return reply.code(403).send({ error: 'bad_host' });
    return undefined;
  });

  const pairFailures = createFailureLimiter({ maxFailures: PAIR_MAX_FAILURES, windowMs: PAIR_FAILURE_WINDOW_MS });
  const tailscaleLogins = new Set(config.allowedTailscaleLogins);

  app.addHook('onRequest', async (request, reply) => {
    if (tailscaleLogins.size === 0 || !isProtectedPath(request.url)) return;
    const login = request.headers['tailscale-user-login'];
    if (typeof login === 'string' && tailscaleLogins.has(login)) return;
    return reply.code(403).send({ error: 'forbidden' });
  });

  // Upgrade do WS: Origin de fora (que não é a própria origem nem corsOrigins) → 403 antes do 101.
  // O plugin de WS passa por onRequest antes de decidir o upgrade, então a resposta sai como HTTP normal.
  app.addHook('onRequest', async (request, reply) => {
    if (pathOf(request.url) !== '/ws') return;
    const allowed = isAllowedWsOrigin(
      {
        origin: headerText(request.headers.origin),
        host: headerText(request.headers.host),
        forwardedHost: headerText(request.headers['x-forwarded-host']),
        forwardedProto: headerText(request.headers['x-forwarded-proto']),
        encrypted: isTlsSocket(request.socket),
      },
      config.corsOrigins,
    );
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    return undefined;
  });

  /** Bearer de dispositivo ativo; sem ele, 401. Roda em onRequest, antes de ler o corpo. */
  const requireDevice = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const device = authenticateToken(db, bearerToken(request.headers.authorization), Date.now());
    if (device === undefined) return reply.code(401).send({ error: 'unauthorized' });
    return undefined;
  };

  // PWA em outra origem (PC secundário): só GET/POST/PATCH/DELETE, sem credenciais (nada de cookie).
  await app.register(fastifyCors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-File-Name'],
    credentials: false,
  });

  app.get('/api/health', async () => {
    const body: HealthResponse = { ok: true, machineId: machine.id, machineName: machine.name, version };
    return body;
  });

  app.post('/api/pair', async (request, reply) => {
    // Chave do limite: o login do Tailscale quando o header existe (atrás do tailscale serve, o IP é sempre o
    // do proxy); senão o IP. Prefixo separa as duas namespaces.
    const login = headerText(request.headers['tailscale-user-login']);
    const key = login !== undefined && login !== '' ? `login:${login}` : `ip:${request.ip}`;
    const now = Date.now();
    if (pairFailures.isBlocked(key, now)) {
      return reply.code(429).send({ error: 'too_many_attempts' });
    }

    const parsed = PairRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // Corpo inválido também conta: senão dá para martelar a rota sem ser limitado.
      pairFailures.recordFailure(key, now);
      return reply.code(400).send({ error: 'invalid_body' });
    }

    const result = pairDevice(db, { code: parsed.data.code, deviceName: parsed.data.deviceName, now });
    if (!result.ok) {
      pairFailures.recordFailure(key, now);
      request.log.warn({ reason: result.reason }, 'pareamento recusado');
      return reply.code(401).send({ error: 'invalid_code' });
    }

    const body: PairResponse = {
      token: result.token,
      deviceId: result.deviceId,
      machineId: machine.id,
      machineName: machine.name,
    };
    return body;
  });

  app.get('/api/me', async (request, reply) => {
    const device = authenticateToken(db, bearerToken(request.headers.authorization), Date.now());
    if (device === undefined) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body: MeResponse = {
      deviceId: device.id,
      deviceName: device.name,
      machineId: machine.id,
      machineName: machine.name,
    };
    return body;
  });

  // Rotas de pastas, workspaces, sessões e push: exigem Bearer de dispositivo ativo.
  app.decorateRequest('device', null);
  await app.register(async (api) => {
    api.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
      const device = authenticateToken(db, bearerToken(request.headers.authorization), Date.now());
      if (device === undefined) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      request.device = device;
      return undefined;
    });

    api.get('/api/roots', async () => {
      const body: RootsResponse = { roots: describeRoots(config.allowedRoots) };
      return body;
    });

    api.get<{ Querystring: { path?: unknown } }>('/api/fs', async (request, reply) => {
      const path: unknown = request.query.path;
      if (typeof path !== 'string' || path.length === 0) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const body: FsListResponse = listDirectory(path, config.allowedRoots);
      return body;
    });

    api.get('/api/agents', async () => {
      const body: AgentsResponse = {
        agents: Object.entries(config.agents).map(([id, agent]) => ({ id, label: agent.label, kind: agent.kind })),
      };
      return body;
    });

    api.get<{ Querystring: { refresh?: unknown } }>('/api/agents/accounts', async (request) => {
      const body: AgentAccountsResponse = {
        accounts: await agentAccounts.list({ refresh: request.query.refresh === '1' }),
      };
      return body;
    });

    api.get('/api/workspaces', async () => {
      const body: WorkspacesResponse = { workspaces: listWorkspaces(db) };
      return body;
    });

    api.get<{ Params: { id: string } }>('/api/workspaces/:id/info', async (request, reply) => {
      const workspace = findWorkspaceById(db, request.params.id);
      if (workspace === undefined) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body: WorkspaceInfoResponse = await workspaceInfo(workspace.path);
      return body;
    });

    api.post('/api/workspaces', async (request, reply) => {
      const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const path = resolveInsideRoots(parsed.data.path, config.allowedRoots);
      const existing = findWorkspaceByPath(db, path);
      if (existing !== undefined) {
        const body: Workspace = existing;
        return reply.code(200).send(body);
      }

      const workspace: Workspace = {
        id: randomUUID(),
        name: parsed.data.name ?? (basename(path) || path),
        path,
        createdAt: Date.now(),
        muted: false,
      };
      insertWorkspace(db, workspace);
      return reply.code(201).send(workspace);
    });

    api.patch<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
      const parsed = UpdateWorkspaceRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const workspace = setWorkspaceMuted(db, request.params.id, parsed.data.muted);
      if (workspace === undefined) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body: Workspace = workspace;
      return body;
    });

    api.delete<{ Params: { id: string } }>('/api/workspaces/:id', async (request, reply) => {
      const { id } = request.params;
      const result = deleteWorkspace(db, id, Date.now());
      if (result === undefined) {
        return reply.code(404).send({ error: 'not_found' });
      }
      await sessions.stopSessions(result.sessionIds);
      // Depois de parar os agentes (que podem estar com arquivos abertos). A linha da sessão continua no banco.
      await removeSessionFiles(
        filesRoot,
        listSessionsByWorkspace(db, id).map((session) => session.id),
        (error) => app.log.warn({ err: error }, 'não apagou a pasta de arquivos da sessão'),
      );
      await onWorkspaceDeleted?.({ workspaceId: id, sessionIds: result.sessionIds });
      return reply.code(204).send();
    });

    api.get<{ Params: { id: string } }>('/api/workspaces/:id/sessions', async (request, reply) => {
      if (findWorkspaceById(db, request.params.id) === undefined) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body: SessionsResponse = { sessions: listSessionsByWorkspace(db, request.params.id) };
      return body;
    });

    // Sessões que o agente tem para a pasta do workspace, para importar com POST /api/sessions (resumeAcpSessionId).
    api.get<{ Params: { id: string }; Querystring: { agent?: unknown; cursor?: unknown } }>(
      '/api/workspaces/:id/agent-sessions',
      async (request, reply) => {
        const { agent, cursor } = request.query;
        if (typeof agent !== 'string' || agent.length === 0) {
          return reply.code(400).send({ error: 'invalid_request' });
        }
        if (cursor !== undefined && typeof cursor !== 'string') {
          return reply.code(400).send({ error: 'invalid_request' });
        }
        const body: AgentSessionsResponse = await sessions.listAgentSessions(
          request.params.id,
          agent,
          cursor === undefined || cursor === '' ? undefined : cursor,
        );
        return body;
      },
    );

    api.post('/api/sessions', async (request, reply) => {
      const parsed = CreateSessionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const body: Session = await sessions.create(parsed.data);
      return reply.code(201).send(body);
    });

    // `removeWorktree=1` remove o worktree depois de parar a sessão (sujo → 409, a sessão para mesmo assim).
    // `forget=1` (remover do app) apaga a sessão do banco com eventos e arquivos, depois de parar. Não fala com o
    // agente: o histórico dele continua e a sessão volta a aparecer em Retomar do PC. Worktree só sai com removeWorktree.
    api.delete<{ Params: { id: string }; Querystring: { removeWorktree?: unknown; forget?: unknown } }>(
      '/api/sessions/:id',
      async (request, reply) => {
        const { id } = request.params;
        await sessions.stop(id);
        if (request.query.removeWorktree === '1') await sessions.removeWorktree(id);
        if (request.query.forget === '1') {
          sessions.forget(id);
          await removeSessionFiles(filesRoot, [id], (error) =>
            app.log.warn({ err: error }, 'não apagou a pasta de arquivos da sessão'),
          );
          broadcast({ type: 'session_removed', sessionId: id });
        }
        return reply.code(204).send();
      },
    );

    api.post<{ Params: { id: string } }>('/api/sessions/:id/resume', async (request, reply) => {
      const body: Session = await sessions.resume(request.params.id);
      return reply.code(200).send(body);
    });

    // Diff no cwd da sessão (worktree, se houver). Não-git → lista vazia.
    api.get<{ Params: { id: string } }>('/api/sessions/:id/diff', async (request) => {
      const cwd = sessions.workingDirectory(request.params.id);
      const body: SessionDiffResponse = await sessionDiff(cwd);
      return body;
    });

    // Comandos que o agente anunciou por último (vazia se nenhum). Fora da listagem: ver CommandsResponseSchema.
    api.get<{ Params: { id: string } }>('/api/sessions/:id/commands', async (request, reply) => {
      const commands = findSessionCommands(db, request.params.id);
      if (commands === undefined) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body: CommandsResponse = { commands };
      return body;
    });

    // Opções de configuração que valem agora (vazia se nenhuma). Fora da Session: ver ConfigOptionsResponseSchema.
    api.get<{ Params: { id: string } }>('/api/sessions/:id/config', async (request, reply) => {
      const configOptions = findSessionConfigOptions(db, request.params.id);
      if (configOptions === undefined) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const body: ConfigOptionsResponse = { configOptions };
      return body;
    });

    api.get<{ Params: { id: string }; Querystring: { after?: unknown; limit?: unknown } }>(
      '/api/sessions/:id/events',
      async (request, reply) => {
        const { id } = request.params;
        if (findSessionById(db, id) === undefined) {
          return reply.code(404).send({ error: 'not_found' });
        }
        const after = parseIntParam(request.query.after, { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
        const limit = parseIntParam(request.query.limit, {
          fallback: EVENTS_DEFAULT_LIMIT,
          min: 1,
          max: EVENTS_MAX_LIMIT,
        });
        if (after === undefined || limit === undefined) {
          return reply.code(400).send({ error: 'invalid_request' });
        }
        const body: EventsResponse = { events: listEvents(db, id, after, limit) };
        return body;
      },
    );

    // Devices pareados que não foram revogados. `current` é o device que fez esta chamada.
    api.get('/api/devices', async (request) => {
      const current = request.device?.id;
      const body: DevicesResponse = {
        devices: listActiveDevices(db).map((device) => ({
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
          current: device.id === current,
        })),
      };
      return body;
    });

    // Revoga (apaga as inscrições de push) e derruba os WS do device na hora. 404 para inexistente ou já revogado.
    api.delete<{ Params: { id: string } }>('/api/devices/:id', async (request, reply) => {
      const { id } = request.params;
      if (!revokeDevice(db, id, Date.now())) {
        return reply.code(404).send({ error: 'not_found' });
      }
      connections.closeDevice(id, WS_UNAUTHORIZED, 'unauthorized');
      return reply.code(204).send();
    });

    api.get('/api/push/key', async () => {
      const body: PushKeyResponse = { publicKey: vapidPublicKey };
      return body;
    });

    // Upsert por endpoint: o navegador renova as chaves sem criar linha nova. A inscrição fica com o device do token.
    // Endpoint fora dos serviços de push conhecidos → 400; endpoint de outro device → 409 (não reatribui).
    api.post('/api/push/subscribe', async (request, reply) => {
      const parsed = PushSubscriptionRequestSchema.safeParse(request.body);
      const device = request.device;
      if (!parsed.success || device === null) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      if (!isAllowedPushEndpoint(parsed.data.endpoint)) {
        return reply.code(400).send({ error: 'bad_push_endpoint' });
      }
      const owner = findPushSubscriptionOwner(db, parsed.data.endpoint);
      if (owner !== undefined && owner !== device.id) {
        return reply.code(409).send({ error: 'endpoint_in_use' });
      }
      upsertPushSubscription(db, {
        endpoint: parsed.data.endpoint,
        deviceId: device.id,
        keys: parsed.data.keys,
        createdAt: Date.now(),
      });
      return reply.code(204).send();
    });

    // Só apaga inscrição do próprio device: endpoint de outro device (ou inexistente) → 404.
    api.delete('/api/push/subscribe', async (request, reply) => {
      const parsed = PushUnsubscribeRequestSchema.safeParse(request.body);
      const device = request.device;
      if (!parsed.success || device === null) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      if (!deletePushSubscription(db, parsed.data.endpoint, device.id)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(204).send();
    });
  });

  /**
   * Replay do banco (seq > afterSeq, em lotes, cedendo o loop) e depois ao vivo. Enquanto o replay roda,
   * os eventos ao vivo ficam num buffer; no fim, entram só os de seq maior que o último entregue.
   * Um novo subscribe ou unsubscribe cancela o anterior (`active` vira false e ele para de enviar).
   */
  async function subscribe(
    socket: WebSocket,
    subscriptions: Subscriptions,
    sessionId: string,
    afterSeq: number,
  ): Promise<void> {
    if (findSessionById(db, sessionId) === undefined) {
      throw new SessionError('not_found', 'sessão não encontrada');
    }
    subscriptions.get(sessionId)?.();

    let active = true;
    let replaying = true;
    let last = afterSeq;
    const deliver = (event: SessionEvent): void => {
      if (!active || event.seq <= last) return;
      last = event.seq;
      send(socket, { type: 'event', event });
    };

    const buffered: SessionEvent[] = [];
    const cancelLive = sessions.subscribe(sessionId, {
      event: (event) => {
        if (replaying) buffered.push(event);
        else deliver(event);
      },
      // Durante o replay não manda: a lista lida depois dele já inclui essa mudança (gravada antes de avisar).
      commands: (commands) => {
        if (active && !replaying) send(socket, { type: 'commands', sessionId, commands });
      },
      configOptions: (configOptions) => {
        if (active && !replaying) send(socket, { type: 'config_options', sessionId, configOptions });
      },
    });
    subscriptions.set(sessionId, () => {
      active = false;
      cancelLive();
    });

    await replayEvents(db, sessionId, afterSeq, deliver, { isActive: () => active });
    replaying = false;
    buffered.forEach(deliver);
    // Sem await entre o fim do replay e esta leitura: a lista é a atual. Vazia não se manda.
    const commands = findSessionCommands(db, sessionId) ?? [];
    if (active && commands.length > 0) send(socket, { type: 'commands', sessionId, commands });
    const configOptions = findSessionConfigOptions(db, sessionId) ?? [];
    if (active && configOptions.length > 0) send(socket, { type: 'config_options', sessionId, configOptions });
  }

  async function handleClientMessage(socket: WebSocket, subscriptions: Subscriptions, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case 'ping':
        send(socket, { type: 'pong' });
        return;
      case 'subscribe':
        await subscribe(socket, subscriptions, message.sessionId, message.afterSeq);
        return;
      case 'unsubscribe':
        subscriptions.get(message.sessionId)?.();
        subscriptions.delete(message.sessionId);
        return;
      case 'prompt':
        await sessions.prompt(message.sessionId, message.text, message.attachments ?? []);
        return;
      case 'permission_response':
        sessions.respondPermission(message.sessionId, message.requestId, message.optionId);
        return;
      case 'cancel':
        sessions.cancel(message.sessionId);
        return;
      case 'set_config':
        await sessions.setConfig(message.sessionId, message.configId, message.value);
        return;
      case 'terminal_input':
        sessions.terminalInput(message.sessionId, message.data);
        return;
      case 'terminal_resize':
        sessions.terminalResize(message.sessionId, message.cols, message.rows);
        return;
    }
  }

  function reportCommandError(socket: WebSocket, message: ClientMessage, error: unknown): void {
    const sessionId = 'sessionId' in message ? message.sessionId : undefined;
    const withSession = sessionId === undefined ? {} : { sessionId };
    if (error instanceof SessionError) {
      send(socket, { type: 'error', message: error.message, ...withSession });
      return;
    }
    app.log.error({ err: error, type: message.type }, 'erro em mensagem ws');
    send(socket, { type: 'error', message: 'erro interno', ...withSession });
  }

  app.get('/ws', { websocket: true }, (socket, request) => {
    const token = new URL(request.url, 'http://localhost').searchParams.get('token') ?? undefined;
    const device = authenticateToken(db, token, Date.now());
    if (device === undefined) {
      socket.close(WS_UNAUTHORIZED, 'unauthorized');
      return;
    }

    // Revogação (ex.: `npm run revoke` em outro processo) vale para o WS aberto: checa a cada mensagem e a cada intervalo.
    const revalidate = (): boolean => {
      if (authenticateToken(db, token, Date.now()) !== undefined) return true;
      socket.close(WS_UNAUTHORIZED, 'unauthorized');
      return false;
    };
    const revalidateTimer = setInterval(revalidate, wsRevalidateMs);

    connections.add(device.id, socket);
    const subscriptions: Subscriptions = new Map();
    send(socket, { type: 'hello', machineId: machine.id, machineName: machine.name });

    socket.on('message', (data) => {
      if (!revalidate()) return;
      const parsed = parseClientMessage(rawDataToText(data));
      if (!parsed.ok) {
        request.log.warn({ error: parsed.error }, 'mensagem ws inválida ignorada');
        return;
      }
      const message = parsed.value;
      handleClientMessage(socket, subscriptions, message).catch((error: unknown) => {
        reportCommandError(socket, message, error);
      });
    });

    socket.on('close', () => {
      clearInterval(revalidateTimer);
      connections.remove(device.id, socket);
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    });

    // Sem listener, um erro no socket derrubaria o processo.
    socket.on('error', (error) => {
      request.log.warn({ message: error.message }, 'erro no socket ws');
    });
  });

  await registerFileRoutes(app, {
    db,
    sessions,
    filesRoot,
    requireDevice,
  });

  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/' });
  }

  const indexFile = join(staticDir, 'index.html');
  app.setNotFoundHandler(async (request, reply) => {
    if (isApiPath(request.url)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!existsSync(indexFile)) {
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('PWA não compilada: rode npm run build -w @nanachi/pwa');
    }
    if (request.method !== 'GET') {
      return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    }
    // no-cache: o PWA novo tem que chegar ao reabrir, mesmo sem arquivo com hash na URL.
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(createReadStream(indexFile));
  });

  return app;
}
