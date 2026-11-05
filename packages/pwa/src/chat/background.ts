import { BACKGROUND_JOBS_MAX, type Background, type BackgroundJob, type SessionStatus } from '@nanachi/shared';
import { t } from '../i18n/index.js';
import type { BackgroundTiming, ChatItem } from './reducer.js';

/*
 * Background work (subagents, background commands, jobs) as the chat shows it. Pure functions over the chat
 * items; the daemon derives the fields (PLAN.md, "subagentes e segundo plano (fase 1)").
 */

export type BackgroundState = Background['state'];
export type BackgroundKind = Background['kind'];

/** What the state of the chat says about background work: is a turn running, and how many turns have ended. */
export interface BackgroundView {
  readonly active: boolean;
  readonly turnEnds: number;
}

/** The fields the effective state is computed from. */
export interface BackgroundSource {
  readonly background: Background;
  readonly timing?: BackgroundTiming | undefined;
}

/** Job status words of Codex and omp (the daemon's table in tool-background.ts). Anything else is unknown. */
const JOB_VERDICT: Readonly<Record<string, BackgroundState>> = {
  pending: 'running',
  queued: 'running',
  running: 'running',
  in_progress: 'running',
  pendingInit: 'running',
  failed: 'failed',
  error: 'failed',
  errored: 'failed',
  notFound: 'failed',
  cancelled: 'stopped',
  canceled: 'stopped',
  aborted: 'stopped',
  interrupted: 'stopped',
  shutdown: 'stopped',
  completed: 'completed',
  done: 'completed',
};

/**
 * State of one job. A job that still says running is unknown when its parent is no longer running, the same rule
 * as for the parent item.
 */
export function jobStateOf(job: BackgroundJob, parent: BackgroundState): BackgroundState {
  const verdict = Object.hasOwn(JOB_VERDICT, job.status) ? JOB_VERDICT[job.status] : undefined;
  if (verdict === undefined) return 'unknown';
  if (verdict === 'running' && parent !== 'running') return 'unknown';
  return verdict;
}

/** One background item, as the drawer and the header chip list it. `id` is the chat item id (the card). */
export interface BackgroundEntry {
  readonly id: string;
  readonly kind: BackgroundKind;
  readonly state: BackgroundState;
  readonly label: string;
  readonly agentType: string | undefined;
  readonly jobs: readonly BackgroundJob[];
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly startEnds: number;
}

export interface BackgroundGroups {
  readonly subagents: readonly BackgroundEntry[];
  readonly commands: readonly BackgroundEntry[];
  readonly jobs: readonly BackgroundEntry[];
}

/** A session status in which a turn is still running and its background work may still be going. */
export function isActiveStatus(status: SessionStatus): boolean {
  return status === 'running' || status === 'awaiting_permission';
}

/**
 * State the user should see. A `running` item is `unknown` once its turn has ended (the daemon never writes an
 * end event for it) or when the session is no longer active. Any other state is already final.
 */
export function effectiveState(source: BackgroundSource, view: BackgroundView): BackgroundState {
  const raw = source.background.state;
  if (raw !== 'running') return raw;
  if (!view.active) return 'unknown';
  if (source.timing !== undefined && view.turnEnds > source.timing.seenEnds) return 'unknown';
  return 'running';
}

/**
 * Background items, newest first. Tool calls without background, and background items without timing, are left out.
 */
export function backgroundEntries(items: readonly ChatItem[], view: BackgroundView): BackgroundEntry[] {
  const entries: BackgroundEntry[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind !== 'tool_call' || item.background === undefined || item.timing === undefined) continue;
    entries.push({
      id: item.id,
      kind: item.background.kind,
      state: effectiveState({ background: item.background, timing: item.timing }, view),
      label: item.background.label ?? (item.title !== '' ? item.title : t('chat:background.untitled')),
      agentType: item.background.agentType,
      jobs: item.background.jobs ?? [],
      startedAt: item.timing.startedAt,
      updatedAt: item.timing.updatedAt,
      startEnds: item.timing.startEnds,
    });
  }
  return entries;
}

/**
 * Whether an entry counts toward the header chip: running now, or unknown since the latest turn (the one that just
 * ended, or the one in progress). Older unknown items are only in the drawer.
 */
export function isChipEntry(entry: BackgroundEntry, turnEnds: number): boolean {
  if (entry.state === 'running') return true;
  return entry.state === 'unknown' && entry.startEnds >= turnEnds - 1;
}

export function backgroundChipCount(entries: readonly BackgroundEntry[], turnEnds: number): number {
  return entries.filter((entry) => isChipEntry(entry, turnEnds)).length;
}

/** Drawer sections, in their order. Keeps the newest-first order inside each. */
export function groupEntries(entries: readonly BackgroundEntry[]): BackgroundGroups {
  return {
    subagents: entries.filter((entry) => entry.kind === 'subagent'),
    commands: entries.filter((entry) => entry.kind === 'shell'),
    jobs: entries.filter((entry) => entry.kind === 'job'),
  };
}

/** Elapsed time: "45 s", "2 min", "1 h 5 min" (the units read the same in Portuguese and English). Negative values (clock skew) read as zero. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Jobs keyed by id. A later entry replaces the status; the label stays when the newer job has none. Order is the
 * first appearance of each id, and the list is capped like the daemon's (BACKGROUND_JOBS_MAX).
 */
export function mergeJobs(previous: readonly BackgroundJob[], next: readonly BackgroundJob[]): BackgroundJob[] {
  const byId = new Map<string, BackgroundJob>(previous.map((job) => [job.id, job]));
  for (const job of next) {
    const label = job.label ?? byId.get(job.id)?.label;
    byId.set(job.id, { id: job.id, ...(label !== undefined ? { label } : {}), status: job.status });
  }
  return [...byId.values()].slice(0, BACKGROUND_JOBS_MAX);
}

/**
 * The background of a tool call after an update: the newer one replaces the older one, except its jobs, which merge
 * by id. An update without background keeps the one already known.
 */
export function mergeBackground(previous: Background | undefined, next: Background | undefined): Background | undefined {
  if (next === undefined) return previous;
  if (previous?.jobs === undefined && next.jobs === undefined) return next;
  const jobs = mergeJobs(previous?.jobs ?? [], next.jobs ?? []);
  return jobs.length === 0 ? next : { ...next, jobs };
}
