import { z } from 'zod';
import { AgentKindSchema } from './config.js';

/** Workspace = pasta permitida onde as sessões rodam. */
export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  /** Silencia push (Fase 3) para as sessões deste workspace. */
  muted: z.boolean(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Arquivo trocado com o celular (anexo do usuário ou arquivo enviado pelo agente via `phone-send`). */
export const FileInfoSchema = z.object({
  fileId: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export type FileInfo = z.infer<typeof FileInfoSchema>;

export const SessionStatusSchema = z.enum([
  'starting',
  'idle',
  'running',
  'awaiting_permission',
  'stopped',
  'error',
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** Valor aceito para uma opção de sessão (select = string, boolean = boolean). */
export const ConfigValueSchema = z.union([z.string(), z.boolean()]);

export type ConfigValue = z.infer<typeof ConfigValueSchema>;

const SelectOptionSchema = z.object({
  value: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  /** Name of the ACP option group this option came from. Absent when the agent sent a flat list. */
  group: z.string().min(1).nullable().optional(),
});

const SessionConfigOptionBaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
});

/** Opção de configuração do agente (modelo, effort, modo...), vinda de `configOptions` do ACP. */
export const SessionConfigOptionSchema = z.discriminatedUnion('type', [
  SessionConfigOptionBaseSchema.extend({
    type: z.literal('select'),
    currentValue: z.string(),
    options: z.array(SelectOptionSchema),
  }),
  SessionConfigOptionBaseSchema.extend({
    type: z.literal('boolean'),
    currentValue: z.boolean(),
  }),
]);

export type SessionConfigOption = z.infer<typeof SessionConfigOptionSchema>;

/**
 * Comando que o agente anunciou (`available_commands_update` do ACP): `/loop`, `/mcp`, skills. Enviar é um prompt
 * de texto `/<name> <args>`. `hint` é a dica do argumento (ex.: `[intervalo] [prompt]`), ou null.
 */
export const AvailableCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  hint: z.string().nullable(),
});

export type AvailableCommand = z.infer<typeof AvailableCommandSchema>;

/** Sessão de agente dentro de um workspace. */
export const SessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  agent: z.string().min(1),
  /** Espelha o `kind` do agente no config: `acp` (chat) ou `pty` (terminal). */
  kind: AgentKindSchema,
  title: z.string().min(1),
  status: SessionStatusSchema,
  /** Conta do agente que a sessão usa (`null` = conta principal). Ver PLAN.md, várias contas por agente. */
  accountId: z.string().min(1).nullable().default(null),
  /** Worktree git separado da sessão (`null` = roda no cwd do workspace). */
  worktree: z
    .object({
      path: z.string().min(1),
      branch: z.string().min(1),
    })
    .nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export type Session = z.infer<typeof SessionSchema>;

/**
 * Sessão que o agente lista (`session/list`) para a pasta do workspace, ainda não necessariamente no app.
 * `linkedSessionId` é a sessão do app que já usa esse `acpSessionId` (aberta ou parada), senão null.
 */
export const AgentSessionSummarySchema = z.object({
  acpSessionId: z.string().min(1),
  title: z.string().nullable(),
  updatedAt: z.number().int().nonnegative().nullable(),
  linkedSessionId: z.string().min(1).nullable(),
});

export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;

/** Conteúdo de um tool call: texto livre, diff de arquivo ou imagem (arquivo da sessão, baixado por `GET /api/files`). */
export const ToolContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('diff'),
    path: z.string().min(1),
    oldText: z.string().nullable(),
    newText: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    fileId: z.string().min(1),
    mime: z.string().min(1),
  }),
]);

export type ToolContent = z.infer<typeof ToolContentSchema>;

const ToolCallStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);

const PlanEntrySchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['high', 'medium', 'low']),
});

const PermissionOptionSchema = z.object({
  optionId: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

/** Limites do trabalho em segundo plano: texto e lista vêm do agente e entram no banco, então ficam capados. */
export const BACKGROUND_LABEL_MAX = 200;
export const BACKGROUND_JOBS_MAX = 50;

/** Um job dentro de um background: subagente do Codex, job do omp ou item de `wait`. `id` é a chave para juntar updates. */
export const BackgroundJobSchema = z.object({
  id: z.string().min(1).max(BACKGROUND_LABEL_MAX),
  label: z.string().min(1).max(BACKGROUND_LABEL_MAX).optional(),
  status: z.string().min(1).max(40),
});

export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;

/**
 * Trabalho que segue depois do tool call: subagente (`Agent`/`Task` do Claude, `spawnAgent` do Codex), comando em
 * segundo plano (`Bash` com `run_in_background`) ou job do omp (`task`/`wait`). `state: "running"` de um async
 * vale até o fim do turno; o daemon não grava evento de fim para isso (ver PLAN.md, subagentes e segundo plano).
 */
export const BackgroundSchema = z.object({
  kind: z.enum(['subagent', 'shell', 'job']),
  state: z.enum(['running', 'completed', 'failed', 'stopped', 'unknown']),
  label: z.string().min(1).max(BACKGROUND_LABEL_MAX).optional(),
  agentType: z.string().min(1).max(BACKGROUND_LABEL_MAX).optional(),
  jobs: z.array(BackgroundJobSchema).max(BACKGROUND_JOBS_MAX).optional(),
});

export type Background = z.infer<typeof BackgroundSchema>;

/** Campos de tool call que só o trabalho em segundo plano usa. Ausentes em eventos antigos e em tool calls comuns. */
const ToolLineageShape = {
  /** `toolCallId` do tool call pai (subagente que fez esta chamada). */
  parentToolCallId: z.string().min(1).max(BACKGROUND_LABEL_MAX).optional(),
  /** Nome da ferramenta do agente (ex.: `Agent`, `Bash`), quando o agente informa. */
  toolName: z.string().min(1).max(BACKGROUND_LABEL_MAX).optional(),
  background: BackgroundSchema.optional(),
};

const EventMetaShape = {
  seq: z.number().int().positive(),
  sessionId: z.string().min(1),
  ts: z.number().int().nonnegative(),
};

/** Evento gravado em `events` e enviado pelo WS. Discriminado por `kind`. */
export const SessionEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...EventMetaShape,
    kind: z.literal('user_message'),
    text: z.string(),
    attachments: z.array(FileInfoSchema).optional(),
    /** Prompt de uma iteração do loop (PLAN.md, modo Loop). `loopIteration` é o número dela, a partir de 1. */
    loop: z.literal(true).optional(),
    loopIteration: z.number().int().positive().optional(),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('agent_message_chunk'),
    text: z.string(),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('agent_thought_chunk'),
    text: z.string(),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('tool_call'),
    toolCallId: z.string().min(1),
    title: z.string(),
    toolKind: z.string().min(1).optional(),
    status: ToolCallStatusSchema.optional(),
    content: z.array(ToolContentSchema),
    locations: z.array(z.string()),
    ...ToolLineageShape,
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('tool_call_update'),
    toolCallId: z.string().min(1),
    title: z.string().optional(),
    status: ToolCallStatusSchema.optional(),
    content: z.array(ToolContentSchema).optional(),
    ...ToolLineageShape,
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('plan'),
    entries: z.array(PlanEntrySchema),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('permission_request'),
    requestId: z.string().min(1),
    title: z.string(),
    toolKind: z.string().min(1).optional(),
    rawInput: z.unknown().optional(),
    content: z.array(ToolContentSchema),
    options: z.array(PermissionOptionSchema),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('permission_resolved'),
    requestId: z.string().min(1),
    optionId: z.string().min(1).nullable(),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('turn_end'),
    stopReason: z.string().min(1),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('status'),
    status: SessionStatusSchema,
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('error'),
    message: z.string(),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('file'),
    ...FileInfoSchema.shape,
    direction: z.enum(['to_phone', 'from_phone']),
    caption: z.string().optional(),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('terminal_output'),
    data: z.string(),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('account_changed'),
    /** Conta nova da sessão (`null` = principal). `label` é o nome que o PWA mostra. */
    accountId: z.string().min(1).nullable(),
    label: z.string().min(1),
  }),
  z.object({
    ...EventMetaShape,
    kind: z.literal('terminal_exit'),
    exitCode: z.number().int().nullable(),
    /** `reload`: o daemon encerrou o shell para recarregar (exitCode null). Ausente quando o processo saiu sozinho. */
    reason: z.literal('reload').optional(),
  }),
]);

export type SessionEvent = z.infer<typeof SessionEventSchema>;
