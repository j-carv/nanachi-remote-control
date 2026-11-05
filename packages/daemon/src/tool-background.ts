import {
  BACKGROUND_JOBS_MAX,
  BACKGROUND_LABEL_MAX,
  BackgroundSchema,
  type Background,
  type BackgroundJob,
} from '@nanachi/shared';

/**
 * Trabalho em segundo plano que um tool call deixa: subagente, comando em background ou job do omp.
 * Função pura sobre os campos do update ACP; quem guarda o estado entre updates é o chamador (`ToolCallMemory`).
 * Regras e formatos: PLAN.md, "Extra (04/11) — subagentes e segundo plano (fase 1)".
 */

/** Status ACP de um tool call (já validado pelo mapeamento). */
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Campos de um tool call ou update que a derivação lê. `texts` é o texto dos blocos de conteúdo do update. */
export interface ToolFacts {
  /** `_meta` do update (Claude põe `claudeCode.toolName` e `claudeCode.parentToolUseId` aqui). */
  meta: unknown;
  title: string | null | undefined;
  status: ToolStatus | null | undefined;
  rawInput: unknown;
  rawOutput: unknown;
  texts: readonly string[];
}

/** O que o daemon lembra de um tool call entre os updates dele. */
export interface KnownToolCall {
  toolName?: string;
  background?: Background;
}

/** Memória por sessão: `toolCallId` -> o que os próximos updates precisam. Só guarda chamadas com background. */
export type ToolCallMemory = Map<string, KnownToolCall>;

/** Resultado da derivação de um update; cada campo só existe quando há algo a dizer. */
export interface ToolTracking {
  toolName?: string;
  parentToolCallId?: string;
  background?: Background;
}

const CLAUDE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
const CODEX_SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['spawnAgent', 'resumeAgent', 'sendInput', 'followupTask']);
const ASYNC_LAUNCH = /async agent launched/i;
const BASH_BACKGROUND = /running in background/i;
const JOB_STATUS_MAX = 40;

type JobVerdict = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

const RUNNING_STATUSES: ReadonlySet<string> = new Set(['pending', 'queued', 'running', 'in_progress', 'pendingInit']);
const FAILED_STATUSES: ReadonlySet<string> = new Set(['failed', 'error', 'errored', 'notFound']);
const STOPPED_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'canceled', 'aborted', 'interrupted', 'shutdown']);
const COMPLETED_STATUSES: ReadonlySet<string> = new Set(['completed', 'done']);

/** Tabela única de status de job (Codex e omp). Fora da tabela = unknown, e unknown não conta como running. */
function verdictOf(status: string): JobVerdict {
  if (RUNNING_STATUSES.has(status)) return 'running';
  if (FAILED_STATUSES.has(status)) return 'failed';
  if (STOPPED_STATUSES.has(status)) return 'stopped';
  if (COMPLETED_STATUSES.has(status)) return 'completed';
  return 'unknown';
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Texto cortado em `max` pontos de código, sem espaços nas pontas. Vazio vira undefined. */
function capped(text: string, max = BACKGROUND_LABEL_MAX): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return Array.from(trimmed).slice(0, max).join('');
}

function textOf(value: unknown, max = BACKGROUND_LABEL_MAX): string | undefined {
  return typeof value === 'string' ? capped(value, max) : undefined;
}

/** Id que vai como referência (parentToolCallId, toolName). Id acima do limite não é usado: não se corta uma chave. */
function idOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > BACKGROUND_LABEL_MAX) return undefined;
  return value;
}

function jobStatusOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > JOB_STATUS_MAX) return 'unknown';
  return value;
}

/** Um job com id válido; status fora do limite vira unknown. `label` some quando vazio. */
function jobOf(id: unknown, status: unknown, label?: unknown): BackgroundJob | undefined {
  const jobId = idOf(id);
  if (jobId === undefined) return undefined;
  const text = textOf(label);
  return { id: jobId, ...(text !== undefined ? { label: text } : {}), status: jobStatusOf(status) };
}

/** Une jobs pelo id: o item mais novo vence no status; o label antigo fica se o novo não trouxer um. */
function mergeJobs(previous: readonly BackgroundJob[], next: readonly BackgroundJob[]): BackgroundJob[] {
  const byId = new Map<string, BackgroundJob>(previous.map((job) => [job.id, job]));
  for (const job of next) {
    const old = byId.get(job.id);
    const label = job.label ?? old?.label;
    byId.set(job.id, { id: job.id, ...(label !== undefined ? { label } : {}), status: job.status });
  }
  return [...byId.values()].slice(0, BACKGROUND_JOBS_MAX);
}

/** Jobs do Codex: `receiverThreadIds` mais as chaves de `agentsStates`, status de `agentsStates[id].status`. */
function codexJobs(rawInput: Record<string, unknown>): BackgroundJob[] {
  const agentsStates = recordOf(rawInput.agentsStates);
  const ids: string[] = [];
  if (Array.isArray(rawInput.receiverThreadIds)) {
    for (const id of rawInput.receiverThreadIds) if (typeof id === 'string') ids.push(id);
  }
  if (agentsStates !== undefined) ids.push(...Object.keys(agentsStates));
  const jobs: BackgroundJob[] = [];
  for (const id of new Set(ids)) {
    const job = jobOf(id, recordOf(agentsStates?.[id])?.status);
    if (job !== undefined) jobs.push(job);
  }
  return jobs;
}

/** Jobs do omp: `details.async`, `details.progress[]`, `details.results[]` e `details.jobs[]` (wait). */
function ompJobs(details: Record<string, unknown>): BackgroundJob[] {
  const jobs: BackgroundJob[] = [];
  const async = recordOf(details.async);
  if (async !== undefined) {
    const job = jobOf(async.jobId, async.state);
    if (job !== undefined) jobs.push(job);
  }
  for (const item of Array.isArray(details.progress) ? details.progress : []) {
    const record = recordOf(item);
    const job = jobOf(record?.id, record?.status, record?.task);
    if (job !== undefined) jobs.push(job);
  }
  for (const item of Array.isArray(details.results) ? details.results : []) {
    const record = recordOf(item);
    const job = jobOf(record?.id, record?.status ?? 'completed');
    if (job !== undefined) jobs.push(job);
  }
  for (const item of Array.isArray(details.jobs) ? details.jobs : []) {
    const record = recordOf(item);
    const job = jobOf(record?.id, record?.status);
    if (job !== undefined) jobs.push(job);
  }
  return jobs;
}

/** Quais campos do omp existem no update: é job se o `task` veio com tasks ou se o resultado traz details de job. */
function ompDetailsOf(rawOutput: unknown): Record<string, unknown> | undefined {
  const details = recordOf(recordOf(rawOutput)?.details);
  if (details === undefined) return undefined;
  const isJob = ['async', 'progress', 'results', 'jobs'].some((key) => details[key] !== undefined);
  return isJob ? details : undefined;
}

/** Tipo do trabalho deste update: pelo que ele diz; sem sinal novo, o tipo já conhecido. */
function kindOf(
  facts: ToolFacts,
  toolName: string | undefined,
  known: Background | undefined,
): Background['kind'] | undefined {
  const rawInput = recordOf(facts.rawInput);
  if (toolName !== undefined && CLAUDE_SUBAGENT_TOOLS.has(toolName)) return 'subagent';
  if (toolName === 'Bash') {
    const flagged = rawInput?.run_in_background === true;
    const announced = facts.texts.some((text) => BASH_BACKGROUND.test(text));
    if (flagged || announced || known?.kind === 'shell') return 'shell';
  }
  // Codex: by title, or by its rawInput shape when a later update arrives without a title.
  const title = facts.title ?? undefined;
  const codexShape = Array.isArray(rawInput?.receiverThreadIds) || recordOf(rawInput?.agentsStates) !== undefined;
  if (title !== undefined && CODEX_SUBAGENT_TOOLS.has(title)) return 'subagent';
  if (codexShape && (title === undefined || title === 'wait')) return 'subagent';
  if (Array.isArray(rawInput?.tasks) || ompDetailsOf(facts.rawOutput) !== undefined) return 'job';
  return known?.kind;
}

/**
 * Estado de um subagente ou job a partir do status do tool call e dos jobs dele. Um async do Claude
 * ("Async agent launched") segue running: o fim real não chega aos clientes simples.
 */
function stateOf(
  status: ToolStatus | null | undefined,
  jobs: readonly BackgroundJob[],
  asyncLaunch: boolean,
  known: Background | undefined,
): Background['state'] {
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'in_progress') return 'running';
  if (status === undefined || status === null) return known?.state ?? 'running';
  if (asyncLaunch) return 'running';
  const verdicts = jobs.map((job) => verdictOf(job.status));
  if (verdicts.includes('running')) return 'running';
  if (verdicts.includes('failed')) return 'failed';
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'stopped')) return 'stopped';
  return 'completed';
}

/**
 * Background deste update, com o que já se sabia do tool call. Devolve undefined quando não há trabalho em
 * segundo plano. O resultado é validado com o schema do shared: o que não passar vira undefined (o evento segue sem ele).
 */
function backgroundOf(facts: ToolFacts, toolName: string | undefined, known: Background | undefined): Background | undefined {
  const kind = kindOf(facts, toolName, known);
  if (kind === undefined) return undefined;
  const rawInput = recordOf(facts.rawInput);
  const details = ompDetailsOf(facts.rawOutput);
  const claudeSubagent = toolName !== undefined && CLAUDE_SUBAGENT_TOOLS.has(toolName);
  const asyncLaunch = facts.texts.some((text) => ASYNC_LAUNCH.test(text));

  // Claude's own label is the description it sent; Codex and omp use the tool title.
  const own = claudeSubagent || kind === 'shell' ? textOf(rawInput?.description) : textOf(facts.title);
  const label = own ?? known?.label;
  const agentType = claudeSubagent ? textOf(rawInput?.subagent_type) ?? known?.agentType : undefined;

  // Only Codex and omp report jobs. A shell has none, and a Claude subagent reports its result as one call.
  let jobs: BackgroundJob[] | undefined;
  if (kind !== 'shell' && !claudeSubagent) {
    const fresh: BackgroundJob[] = [];
    if (rawInput !== undefined && (Array.isArray(rawInput.receiverThreadIds) || recordOf(rawInput.agentsStates) !== undefined)) {
      fresh.push(...codexJobs(rawInput));
    }
    if (details !== undefined) fresh.push(...ompJobs(details));
    const merged = mergeJobs(known?.jobs ?? [], fresh);
    jobs = merged.length > 0 ? merged : undefined;
  }

  const state: Background['state'] =
    kind === 'shell'
      ? facts.status === 'failed'
        ? 'failed'
        : 'running'
      : stateOf(facts.status, jobs ?? [], asyncLaunch, known);

  const candidate: Background = {
    kind,
    state,
    ...(label !== undefined ? { label } : {}),
    ...(agentType !== undefined ? { agentType } : {}),
    ...(jobs !== undefined ? { jobs } : {}),
  };
  // Derived values are already capped; the schema check keeps an unexpected shape from dropping the whole event.
  const parsed = BackgroundSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** Campos Claude de `_meta`: nome da ferramenta e id do tool call pai. */
function claudeMetaOf(meta: unknown): { toolName?: string; parentToolUseId?: string } {
  const claude = recordOf(recordOf(meta)?.claudeCode);
  const toolName = idOf(claude?.toolName);
  const parentToolUseId = idOf(claude?.parentToolUseId);
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
  };
}

/**
 * Deriva o que um update de tool call acrescenta: nome da ferramenta, pai e background. `known` é o que o daemon
 * já lembra desse `toolCallId`. Função pura: quem grava a memória é `rememberToolCall`.
 */
export function trackToolCall(facts: ToolFacts, known: KnownToolCall | undefined): ToolTracking {
  const claude = claudeMetaOf(facts.meta);
  const toolName = claude.toolName ?? known?.toolName;
  const background = backgroundOf(facts, toolName, known?.background);
  return {
    ...(toolName !== undefined ? { toolName } : {}),
    ...(claude.parentToolUseId !== undefined ? { parentToolCallId: claude.parentToolUseId } : {}),
    ...(background !== undefined ? { background } : {}),
  };
}

/** Guarda o que os próximos updates precisam; chamada sem background não ocupa memória. */
export function rememberToolCall(memory: ToolCallMemory, toolCallId: string, tracking: ToolTracking): void {
  if (tracking.background === undefined) return;
  memory.set(toolCallId, {
    ...(tracking.toolName !== undefined ? { toolName: tracking.toolName } : {}),
    background: tracking.background,
  });
}
