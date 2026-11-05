import { z } from 'zod';
import { AgentKindSchema } from './config.js';
import { ShellIdSchema } from './shell.js';
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
 * Uma conta de um agente (várias contas por agente, PLAN.md). `id` "default" é a conta principal (`isDefault`).
 * `active` marca a conta que sessões novas usam. Os demais campos têm o mesmo sentido de `AgentAccountSchema`.
 */
export const AgentProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  isDefault: z.boolean(),
  active: z.boolean(),
  status: z.enum(['logged_in', 'logged_out', 'unknown']),
  account: z.string().min(1).nullable(),
  detail: z.string().min(1).nullable(),
  checkedAt: z.number().int().nonnegative(),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

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
  /** Agente com contas extras (perfis). Os campos de cima descrevem sempre a conta principal. */
  supportsAccounts: z.boolean().default(false),
  /** Principal primeiro, depois as contas extras. Vazio quando `supportsAccounts` é false. */
  profiles: z.array(AgentProfileSchema).default([]),
});

export type AgentAccount = z.infer<typeof AgentAccountSchema>;

/** Nome de uma conta: recortado, 1 a 40 caracteres. */
const AccountLabelSchema = z.string().trim().min(1).max(40);

/** POST /api/agents/:agent/accounts (Bearer token). */
export const CreateAgentAccountRequestSchema = z.object({
  label: AccountLabelSchema,
});

export type CreateAgentAccountRequest = z.infer<typeof CreateAgentAccountRequestSchema>;

/** PATCH /api/agents/:agent/accounts/:accountId (Bearer token). */
export const RenameAgentAccountRequestSchema = z.object({
  label: AccountLabelSchema,
});

export type RenameAgentAccountRequest = z.infer<typeof RenameAgentAccountRequestSchema>;

/** PUT /api/agents/:agent/accounts/active (Bearer token). `default` é a conta principal. */
export const SetActiveAccountRequestSchema = z.object({
  accountId: z.string().min(1),
});

export type SetActiveAccountRequest = z.infer<typeof SetActiveAccountRequestSchema>;

/** PUT /api/agents/:agent/accounts/active: a conta que ficou ativa. */
export const ActiveAccountResponseSchema = z.object({
  accountId: z.string().min(1),
});

export type ActiveAccountResponse = z.infer<typeof ActiveAccountResponseSchema>;

/** PUT /api/sessions/:id/account (Bearer token). `default` é a conta principal. */
export const SetSessionAccountRequestSchema = z.object({
  accountId: z.string().min(1),
});

export type SetSessionAccountRequest = z.infer<typeof SetSessionAccountRequestSchema>;

/** GET /api/agents/accounts[?refresh=1] (Bearer token). Uma entrada por agente do config, na ordem dele. */
export const AgentAccountsResponseSchema = z.object({
  accounts: z.array(AgentAccountSchema),
});

export type AgentAccountsResponse = z.infer<typeof AgentAccountsResponseSchema>;

/**
 * Login of one account (several accounts per agent, PLAN.md). `starting` = the login process is up and has not shown
 * the link yet; `waiting` = there is a link to open (and, for Codex, a code); `verifying` = the login finished and the
 * daemon is checking the account; the last three are final. `needsCode`: the CLI waits for the code pasted back
 * (Claude). `output` = the last 4000 characters of the login output, without escapes and without the code the user
 * pasted.
 */
export const AccountLoginStateSchema = z.object({
  accountId: z.string().min(1),
  state: z.enum(['starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled']),
  url: z.string().min(1).nullable(),
  userCode: z.string().min(1).nullable(),
  needsCode: z.boolean(),
  codeSent: z.boolean(),
  output: z.string(),
  error: z.string().min(1).nullable(),
  /** E-mail (or name) of the connected account. Only when `state` is `succeeded`. */
  account: z.string().min(1).nullable(),
});

export type AccountLoginState = z.infer<typeof AccountLoginStateSchema>;

/** POST /api/agents/:agent/accounts/:accountId/login/code (Bearer token). The code is never returned or logged. */
export const AccountLoginCodeRequestSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(2000)
    // No control characters (C0, DEL and C1): the code is typed into the login terminal.
    .regex(/^[^\p{Cc}]+$/u),
});

export type AccountLoginCodeRequest = z.infer<typeof AccountLoginCodeRequestSchema>;

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
 * `agent: "shell"` abre um terminal na pasta do workspace (ver PLAN.md, terminal no workspace); `shell` escolhe o programa.
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
  /** Só com `agent: "shell"`: qual shell abrir. Ausente = o padrão do PC (pwsh, senão powershell). */
  shell: ShellIdSchema.optional(),
  /** Conta do agente para a sessão (`default` = principal). Ausente = a conta ativa do agente. */
  accountId: z.string().min(1).optional(),
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

/**
 * POST /api/sessions/:id/usage (Bearer token): saída do comando de uso do agente (`/usage` ou `/status`), como
 * veio: ANSI incluso, o PWA remove. Não grava nada na sessão. `fetchedAt` é quando o agente respondeu de verdade.
 * `cached: true` só aparece quando a resposta veio do cache do daemon (leitura de até 30 s atrás).
 */
export const UsageResponseSchema = z.object({
  agent: z.string().min(1),
  text: z.string(),
  fetchedAt: z.number().int().nonnegative(),
  cached: z.literal(true).optional(),
});

export type UsageResponse = z.infer<typeof UsageResponseSchema>;

/**
 * One spendable rate-limit reset, as a usage drawer row. `target` is opaque to the PWA and goes back unchanged on
 * redeem. `usable` counts the resets that can be spent now; `available` the saved ones. `expiresAt` is text as the
 * agent prints it (omp) or ISO-8601 (codex). `note` is the reason or error the agent gave.
 */
export const ResetEntrySchema = z.object({
  target: z.string().min(1).max(200),
  accountLabel: z.string().min(1),
  providerLabel: z.string().min(1).nullable(),
  available: z.number().int().nonnegative(),
  usable: z.number().int().nonnegative(),
  expiresAt: z.string().min(1).nullable(),
  note: z.string().min(1).nullable(),
  active: z.boolean(),
});

export type ResetEntry = z.infer<typeof ResetEntrySchema>;

/**
 * GET /api/sessions/:id/usage/resets (Bearer token): the saved resets of the agent's accounts. `message` carries the
 * agent's line when there are no entries (e.g. "No provider accounts found..."). `cached: true` as in usage.
 */
export const ResetsResponseSchema = z.object({
  agent: z.string().min(1),
  entries: z.array(ResetEntrySchema),
  message: z.string().min(1).nullable(),
  fetchedAt: z.number().int().nonnegative(),
  cached: z.literal(true).optional(),
});

export type ResetsResponse = z.infer<typeof ResetsResponseSchema>;

/** POST /api/sessions/:id/usage/resets (Bearer token) body: the `target` of a row from the listing. */
export const ResetRedeemRequestSchema = z.object({
  target: z.string().min(1).max(200),
});

export type ResetRedeemRequest = z.infer<typeof ResetRedeemRequestSchema>;

/**
 * Result of a redeem. `reset` spent a credit; the others say why nothing was spent (`failed` = the agent did not
 * confirm one of those; `message` is the agent's own line, ANSI removed, or a fixed text for codex).
 */
export const ResetRedeemResponseSchema = z.object({
  outcome: z.enum(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed', 'failed']),
  message: z.string(),
});

export type ResetRedeemResponse = z.infer<typeof ResetRedeemResponseSchema>;

/**
 * Error body for any API route: `error` is the stable code (e.g. `file_changed`); `details` carries extra data when
 * the client needs it (e.g. `dirty` for `dirty_worktree`, the current `etag` for `file_changed`).
 */
export const ErrorResponseSchema = z.object({
  error: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Maximum number of changed paths listed by GET branches and by the 409 `dirty_worktree`. */
export const GIT_DIRTY_LIST_MAX = 200;

/**
 * Repositório git: branches locais; `dirty` lista os caminhos do `git status`. `isRepo` é o discriminante: uma pasta
 * que não é repositório responde `{ isRepo: false }` (GitBranchesNotRepoSchema), sem erro.
 */
export const GitBranchesRepoSchema = z.object({
  isRepo: z.literal(true),
  /** Current branch name; null when HEAD is detached. */
  current: z.string().min(1).nullable(),
  /** Abbreviated commit HEAD points to when detached; null when there is a current branch. */
  detachedAt: z.string().min(1).nullable(),
  branches: z.array(
    z.object({
      name: z.string().min(1),
      current: z.boolean(),
      upstream: z.string().min(1).nullable(),
      /** Committer date of the branch's last commit, in epoch milliseconds. */
      lastCommitAt: z.number().int().nonnegative(),
    }),
  ),
  dirty: z.array(z.string().min(1)).max(GIT_DIRTY_LIST_MAX),
});

export type GitBranchesRepo = z.infer<typeof GitBranchesRepoSchema>;

/** A pasta do workspace não é um repositório git. A troca de branch continua respondendo 400 `not_a_git_repo`. */
export const GitBranchesNotRepoSchema = z.object({
  isRepo: z.literal(false),
});

/** GET /api/workspaces/:id/git/branches (Bearer token). Não é erro quando a pasta não é git: vem `isRepo: false`. */
export const GitBranchesResponseSchema = z.discriminatedUnion('isRepo', [GitBranchesRepoSchema, GitBranchesNotRepoSchema]);

export type GitBranchesResponse = z.infer<typeof GitBranchesResponseSchema>;

/**
 * POST /api/workspaces/:id/git/checkout (Bearer token). `create: true` creates the branch (`git switch -c`); without
 * it, only switches to an existing local branch. The daemon validates the full name with `git check-ref-format`.
 */
export const GitCheckoutRequestSchema = z.object({
  branch: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !name.startsWith('-') && !name.includes('@{'), 'invalid branch name'),
  create: z.boolean().optional(),
});

export type GitCheckoutRequest = z.infer<typeof GitCheckoutRequestSchema>;

/** Entry type in a file listing. A link (symlink or junction) is never followed while listing. */
export const WorkspaceEntryTypeSchema = z.enum(['dir', 'file', 'symlink']);

export type WorkspaceEntryType = z.infer<typeof WorkspaceEntryTypeSchema>;

/**
 * GET /api/workspaces/:id/fs/list?path=<rel> (Bearer token). Folders first, then by name; `.git` is left out.
 * `ignored` is true when `git check-ignore` matches the entry (always false outside a git repository).
 */
export const WorkspaceEntriesResponseSchema = z.object({
  entries: z.array(
    z.object({
      name: z.string().min(1),
      type: WorkspaceEntryTypeSchema,
      size: z.number().int().nonnegative(),
      mtimeMs: z.number().nonnegative(),
      ignored: z.boolean(),
    }),
  ),
});

export type WorkspaceEntriesResponse = z.infer<typeof WorkspaceEntriesResponseSchema>;

/**
 * GET /api/workspaces/:id/fs/file?path=<rel> (Bearer token). UTF-8 text as stored (line endings and BOM included).
 * `etag` is the SHA-256 of the content in hex; the next write sends it back as `baseEtag`.
 */
export const WorkspaceFileResponseSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal('utf8'),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  etag: z.string().min(1),
});

export type WorkspaceFileResponse = z.infer<typeof WorkspaceFileResponseSchema>;

/**
 * PUT /api/workspaces/:id/fs/file (Bearer token). `baseEtag: null` creates the file (409 `file_exists` if it already
 * exists); an etag updates it, and only while the file still has that content (otherwise 409 `file_changed`).
 */
export const WorkspaceFileWriteRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  baseEtag: z.string().min(1).nullable(),
});

export type WorkspaceFileWriteRequest = z.infer<typeof WorkspaceFileWriteRequestSchema>;

/** PUT response: the state that was written (the new etag for the next write). */
export const WorkspaceFileWriteResponseSchema = z.object({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  etag: z.string().min(1),
});

export type WorkspaceFileWriteResponse = z.infer<typeof WorkspaceFileWriteResponseSchema>;

/** POST /api/workspaces/:id/fs/mkdir (Bearer token). Does not create missing parent folders (not recursive). */
export const WorkspaceMkdirRequestSchema = z.object({
  path: z.string().min(1),
});

export type WorkspaceMkdirRequest = z.infer<typeof WorkspaceMkdirRequestSchema>;

/** POST /api/workspaces/:id/fs/rename (Bearer token). */
export const WorkspaceRenameRequestSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export type WorkspaceRenameRequest = z.infer<typeof WorkspaceRenameRequestSchema>;
