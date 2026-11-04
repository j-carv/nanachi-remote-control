import { z } from 'zod';
import { AgentKindSchema } from './config.js';
import {
  AgentSessionSummarySchema,
  AvailableCommandSchema,
  ConfigValueSchema,
  FileInfoSchema,
  SessionConfigOptionSchema,
  SessionEventSchema,
  SessionSchema,
  WorkspaceSchema,
} from './session.js';

/** GET /api/health (sem token). */
export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  machineId: z.string().min(1),
  machineName: z.string().min(1),
  version: z.string().min(1),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** POST /api/pair (sem token). */
export const PairRequestSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
  deviceName: z.string().min(1).max(64),
});

export type PairRequest = z.infer<typeof PairRequestSchema>;

export const PairResponseSchema = z.object({
  token: z.string().min(1),
  deviceId: z.string().min(1),
  machineId: z.string().min(1),
  machineName: z.string().min(1),
});

export type PairResponse = z.infer<typeof PairResponseSchema>;

/** GET /api/me (Bearer token). */
export const MeResponseSchema = z.object({
  deviceId: z.string().min(1),
  deviceName: z.string().min(1),
  machineId: z.string().min(1),
  machineName: z.string().min(1),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;

/** GET /api/roots (Bearer token). */
export const RootsResponseSchema = z.object({
  roots: z.array(
    z.object({
      path: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
});

export type RootsResponse = z.infer<typeof RootsResponseSchema>;

/** GET /api/fs?path=<abs> (Bearer token). `parent` é null na raiz permitida. */
export const FsListResponseSchema = z.object({
  path: z.string().min(1),
  parent: z.string().min(1).nullable(),
  dirs: z.array(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
    }),
  ),
});

export type FsListResponse = z.infer<typeof FsListResponseSchema>;

/** GET /api/agents (Bearer token). `kind` diz se a sessão é ACP ou PTY. */
export const AgentsResponseSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      kind: AgentKindSchema,
    }),
  ),
});

export type AgentsResponse = z.infer<typeof AgentsResponseSchema>;

/**
 * Conta logada em um agente, como o daemon vê. `unknown` = não deu para checar com segurança (ou o agente não tem
 * verificador). `account` é e-mail ou nome de conta; `detail` é organização, plano ou provedores. Nunca segredo.
 */
export const AgentAccountSchema = z.object({
  agentId: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['logged_in', 'logged_out', 'unknown']),
  account: z.string().min(1).nullable(),
  detail: z.string().min(1).nullable(),
  checkedAt: z.number().int().nonnegative(),
});

export type AgentAccount = z.infer<typeof AgentAccountSchema>;

/** GET /api/agents/accounts[?refresh=1] (Bearer token). Uma entrada por agente do config, na ordem dele. */
export const AgentAccountsResponseSchema = z.object({
  accounts: z.array(AgentAccountSchema),
});

export type AgentAccountsResponse = z.infer<typeof AgentAccountsResponseSchema>;

/** GET /api/workspaces (Bearer token). */
export const WorkspacesResponseSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
});

export type WorkspacesResponse = z.infer<typeof WorkspacesResponseSchema>;

/** POST /api/workspaces (Bearer token). `name` default = basename, preenchido pelo daemon. */
export const CreateWorkspaceRequestSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
});

export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

/** GET /api/workspaces/:id/sessions (Bearer token). */
export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionSchema),
});

export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;

/**
 * POST /api/sessions (Bearer token). `config` é aplicado logo após `session/new`.
 * `worktree: true` cria um worktree git separado (só para workspace git).
 * `resumeAcpSessionId` (sessão listada em `agent-sessions`) importa uma sessão criada fora do app: o histórico
 * reenviado pelo agente vira eventos, e `resumeTitle` (título da listagem) dá o título. Sem `worktree`.
 */
export const CreateSessionRequestSchema = z.object({
  workspaceId: z.string().min(1),
  agent: z.string().min(1),
  config: z.record(z.string().min(1), ConfigValueSchema).optional(),
  worktree: z.boolean().optional(),
  resumeAcpSessionId: z.string().min(1).optional(),
  resumeTitle: z.string().min(1).optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/**
 * GET /api/workspaces/:id/agent-sessions?agent=<id>&cursor=<opcional> (Bearer token). `supported` é false para
 * agente de terminal ou que não anuncia `sessionCapabilities.list`. `nextCursor` (null = fim) vai no próximo pedido.
 */
export const AgentSessionsResponseSchema = z.object({
  supported: z.boolean(),
  sessions: z.array(AgentSessionSummarySchema),
  nextCursor: z.string().min(1).nullable(),
});

export type AgentSessionsResponse = z.infer<typeof AgentSessionsResponseSchema>;

/**
 * GET /api/sessions/:id/commands (Bearer token): comandos que o agente anunciou por último (lista vazia se nenhum).
 * Fora da Session de propósito: a listagem e o broadcast `session` não carregam esse payload.
 */
export const CommandsResponseSchema = z.object({
  commands: z.array(AvailableCommandSchema),
});

export type CommandsResponse = z.infer<typeof CommandsResponseSchema>;

/**
 * GET /api/sessions/:id/config (Bearer token): opções de configuração do agente (modelo, effort, modo...) que valem
 * agora (lista vazia se nenhuma). Fora da Session de propósito: a lista de modelos pesa dezenas de KB por sessão.
 */
export const ConfigOptionsResponseSchema = z.object({
  configOptions: z.array(SessionConfigOptionSchema),
});

export type ConfigOptionsResponse = z.infer<typeof ConfigOptionsResponseSchema>;

/** GET /api/sessions/:id/events?after=&limit= (Bearer token). */
export const EventsResponseSchema = z.object({
  events: z.array(SessionEventSchema),
});

export type EventsResponse = z.infer<typeof EventsResponseSchema>;

/** PATCH /api/workspaces/:id (Bearer token). */
export const UpdateWorkspaceRequestSchema = z.object({
  muted: z.boolean(),
});

export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

/** POST /api/sessions/:id/attachments (Bearer token): corpo cru; a resposta descreve o arquivo gravado. */
export const AttachmentResponseSchema = FileInfoSchema;

export type AttachmentResponse = z.infer<typeof AttachmentResponseSchema>;

/** GET /api/push/key (Bearer token): chave pública VAPID da máquina. */
export const PushKeyResponseSchema = z.object({
  publicKey: z.string().min(1),
});

export type PushKeyResponse = z.infer<typeof PushKeyResponseSchema>;

/** POST /api/push/subscribe (Bearer token). */
export const PushSubscriptionRequestSchema = z.object({
  endpoint: z.url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequestSchema>;

/** DELETE /api/push/subscribe (Bearer token). */
export const PushUnsubscribeRequestSchema = z.object({
  endpoint: z.url(),
});

export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequestSchema>;

/** GET /api/workspaces/:id/info (Bearer token). Não-git: `branch` e `changedFiles` são null. */
export const WorkspaceInfoResponseSchema = z.object({
  branch: z.string().nullable(),
  changedFiles: z.number().int().nonnegative().nullable(),
  /** Quais de `CLAUDE.md`, `AGENTS.md` e `GEMINI.md` existem na raiz do workspace. */
  instructions: z.array(z.string()),
});

export type WorkspaceInfoResponse = z.infer<typeof WorkspaceInfoResponseSchema>;

/** GET /api/sessions/:id/diff (Bearer token). `git diff HEAD` no cwd da sessão. */
export const SessionDiffResponseSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      status: z.enum(['added', 'modified', 'deleted', 'renamed']),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      patch: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

export type SessionDiffResponse = z.infer<typeof SessionDiffResponseSchema>;

/** GET /api/devices (Bearer token). Não revogados; `current` marca o device que fez a chamada. */
export const DevicesResponseSchema = z.object({
  devices: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      createdAt: z.number().int().nonnegative(),
      lastSeenAt: z.number().int().nonnegative().nullable(),
      current: z.boolean(),
    }),
  ),
});

export type DevicesResponse = z.infer<typeof DevicesResponseSchema>;
