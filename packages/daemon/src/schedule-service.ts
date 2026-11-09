import { randomUUID } from 'node:crypto';
import {
  SCHEDULE_OUTPUT_MAX,
  SCHEDULES_PER_WORKSPACE_MAX,
  ScheduleInputSchema,
  ScheduleTimingSchema,
  type Schedule,
  type ScheduleModelsResponse,
  type ScheduleRun,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { ApiError } from './api-error.js';
import { findWorkspaceById } from './repository.js';
import type { ScheduleExecutionUpdate, ScheduleExecutor } from './schedule-execution.js';
import { ScheduleRepository, type ScheduleCleanup } from './schedule-repository.js';
import { nextScheduleRun, previewScheduleRuns } from './schedule-time.js';

const MAX_ACTIVE = 4;
const HEARTBEAT_GAP_MS = 10_000;
const STALE_SLOT_MS = 60_000;
const MODEL_TIMEOUT_MS = 30_000;

interface ActiveRun {
  run: ScheduleRun;
  controller: AbortController;
  timer: NodeJS.Timeout;
  done: Promise<void>;
}

interface ModelProbe {
  workspaceId: string;
  controller: AbortController;
  done: Promise<ScheduleModelsResponse>;
}

export interface ScheduleServiceOptions {
  db: Database.Database;
  executor: ScheduleExecutor;
  now?: () => number;
  warn?: (message: string) => void;
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', 'schedule resource not found');
}

function busy(): ApiError {
  return new ApiError(409, 'busy', 'schedule execution is busy');
}

function terminal(run: ScheduleRun): boolean {
  return run.status !== 'running' && run.status !== 'awaiting_permission';
}

/** One durable slot reservation precedes every asynchronous executor call. No missed-slot replay. */
export class ScheduleService {
  private readonly db: Database.Database;
  private readonly executor: ScheduleExecutor;
  private readonly repo: ScheduleRepository;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly active = new Map<string, ActiveRun>();
  private readonly probes = new Set<ModelProbe>();
  private readonly deletingWorkspaces = new Set<string>();
  private readonly deletingSchedules = new Set<string>();
  private readonly pendingCleanup = new Map<string, ScheduleCleanup>();
  private cleanupTask: Promise<void> | undefined;
  private poll: NodeJS.Timeout | undefined;
  private lastHeartbeat: number | undefined;
  private started = false;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: ScheduleServiceOptions) {
    this.db = options.db;
    this.executor = options.executor;
    this.repo = new ScheduleRepository(options.db);
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? (() => undefined);
  }

  start(): void {
    if (this.started || this.closed) return;
    const at = this.now();
    this.repo.recover(at);
    for (const cleanup of this.repo.cleanupKeys()) {
      this.pendingCleanup.set(cleanup.scheduleId, cleanup);
      if (cleanup.remove) this.deletingSchedules.add(cleanup.scheduleId);
    }
    this.started = true;
    this.lastHeartbeat = at;
    this.consumeDue(at, true);
    this.poll = setInterval(() => this.tick(), 1_000);
    this.poll.unref();
    void this.cleanupHistory();
  }

  tick(): void {
    if (!this.started || this.closed) return;
    const at = this.now();
    const gap = this.lastHeartbeat === undefined || at - this.lastHeartbeat > HEARTBEAT_GAP_MS || at < this.lastHeartbeat;
    this.lastHeartbeat = at;
    try {
      this.consumeDue(at, gap);
    } catch {
      this.warn('Schedule polling failed.');
    }
    void this.cleanupHistory();
  }

  list(workspaceId: string): Schedule[] {
    this.workspace(workspaceId);
    return this.repo.list(workspaceId);
  }

  create(workspaceId: string, input: unknown): Schedule {
    this.workspace(workspaceId);
    const parsed = ScheduleInputSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'invalid schedule');
    const at = this.now();
    const future = nextScheduleRun(parsed.data.cronExpression, parsed.data.timeZone, at);
    this.executor.validate(workspaceId, parsed.data.task);
    return this.db.transaction(() => {
      if (this.repo.list(workspaceId).length >= SCHEDULES_PER_WORKSPACE_MAX) {
        throw new ApiError(409, 'schedule_limit', 'workspace schedule limit reached');
      }
      const schedule: Schedule = {
        ...parsed.data, id: randomUUID(), workspaceId, nextRunAt: parsed.data.enabled ? future : null,
        createdAt: at, updatedAt: at,
      };
      this.repo.insert(schedule);
      return schedule;
    })();
  }

  update(workspaceId: string, scheduleId: string, input: unknown): Schedule {
    const previous = this.schedule(workspaceId, scheduleId);
    const parsed = ScheduleInputSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'invalid schedule');
    const at = this.now();
    const future = nextScheduleRun(parsed.data.cronExpression, parsed.data.timeZone, at);
    this.executor.validate(workspaceId, parsed.data.task);
    const schedule: Schedule = {
      ...previous, ...parsed.data, nextRunAt: parsed.data.enabled ? future : null, updatedAt: at,
    };
    this.repo.update(schedule);
    return schedule;
  }

  preview(workspaceId: string, input: unknown): number[] {
    this.workspace(workspaceId);
    const parsed = ScheduleTimingSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'invalid schedule timing');
    return previewScheduleRuns(parsed.data.cronExpression, parsed.data.timeZone, this.now());
  }

  models(workspaceId: string, agentId: string, accountId: string, signal?: AbortSignal): Promise<ScheduleModelsResponse> {
    this.workspace(workspaceId);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted === true) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, MODEL_TIMEOUT_MS);
    timer.unref();
    const probe: ModelProbe = {
      workspaceId, controller,
      done: Promise.resolve().then(() => {
        if (controller.signal.aborted || this.closed) throw busy();
        return this.executor.models(workspaceId, agentId, accountId, controller.signal);
      }).then((result) => {
        if (controller.signal.aborted || this.closed || this.deletingWorkspaces.has(workspaceId)) throw busy();
        return result;
      }).finally(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.probes.delete(probe);
      }),
    };
    this.probes.add(probe);
    return probe.done;
  }

  runNow(workspaceId: string, scheduleId: string): ScheduleRun {
    const schedule = this.schedule(workspaceId, scheduleId);
    if (!this.started || this.closed || this.isBusy(scheduleId) || this.active.size >= MAX_ACTIVE) throw busy();
    this.executor.validate(workspaceId, schedule.task);
    const run = this.makeRun(schedule, 'manual', this.now(), false);
    this.db.transaction(() => this.repo.insertRun(run))();
    this.launch(run, schedule.timeoutMs);
    this.queueCleanup(run);
    return run;
  }

  runs(workspaceId: string, scheduleId: string): ScheduleRun[] {
    this.schedule(workspaceId, scheduleId);
    return this.repo.runs(workspaceId, scheduleId);
  }

  run(workspaceId: string, scheduleId: string, runId: string): ScheduleRun {
    this.schedule(workspaceId, scheduleId);
    const run = this.repo.findRun(workspaceId, scheduleId, runId);
    if (run === undefined) throw notFound();
    return run;
  }

  async cancel(workspaceId: string, scheduleId: string, runId: string): Promise<ScheduleRun> {
    const run = this.run(workspaceId, scheduleId, runId);
    const active = this.active.get(runId);
    if (active !== undefined) {
      this.abort(active, 'cancelled');
      await active.done;
    } else if (!terminal(run)) {
      this.repo.updateActiveRun({ ...run, status: 'interrupted', finishedAt: this.now(), error: 'Execution was interrupted.' });
    }
    this.schedule(workspaceId, scheduleId);
    return this.repo.findRun(workspaceId, scheduleId, runId) ?? active?.run ?? run;
  }

  async remove(workspaceId: string, scheduleId: string): Promise<void> {
    this.schedule(workspaceId, scheduleId);
    this.repo.markDeleting(workspaceId, scheduleId, this.now());
    this.deletingSchedules.add(scheduleId);
    this.pendingCleanup.set(scheduleId, { workspaceId, scheduleId, remove: true });
    await this.cancelMatching((active) => active.run.scheduleId === scheduleId);
    await this.cleanupHistory();
    if (this.pendingCleanup.has(scheduleId)) await this.cleanupHistory();
    if (this.repo.find(workspaceId, scheduleId) !== undefined) {
      throw new ApiError(500, 'cleanup_failed', 'schedule cleanup will be retried');
    }
  }

  /** Leaves the workspace barred while the caller removes sessions and its workspace row. */
  async removeWorkspace(workspaceId: string): Promise<void> {
    this.workspace(workspaceId);
    this.deletingWorkspaces.add(workspaceId);
    const probes = [...this.probes].filter((probe) => probe.workspaceId === workspaceId);
    for (const probe of probes) probe.controller.abort();
    await Promise.all([
      this.cancelMatching((active) => active.run.workspaceId === workspaceId),
      ...probes.map((probe) => probe.done.catch(() => undefined)),
      this.cleanupTask,
    ]);
    this.repo.removeWorkspace(workspaceId);
    for (const [id, cleanup] of this.pendingCleanup) {
      if (cleanup.workspaceId === workspaceId) {
        this.pendingCleanup.delete(id);
        this.deletingSchedules.delete(id);
      }
    }
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    clearInterval(this.poll);
    const probes = [...this.probes];
    for (const probe of probes) probe.controller.abort();
    this.closing = Promise.all([
      this.cancelMatching(() => true), ...probes.map((probe) => probe.done.catch(() => undefined)),
      this.cleanupTask,
    ]).then(() => undefined);
    return this.closing;
  }

  private workspace(workspaceId: string): void {
    if (this.closed) throw busy();
    if (this.deletingWorkspaces.has(workspaceId) || findWorkspaceById(this.db, workspaceId) === undefined) throw notFound();
  }

  private schedule(workspaceId: string, scheduleId: string): Schedule {
    this.workspace(workspaceId);
    if (this.deletingSchedules.has(scheduleId)) throw notFound();
    const schedule = this.repo.find(workspaceId, scheduleId);
    if (schedule === undefined) throw notFound();
    return schedule;
  }

  private isBusy(scheduleId: string): boolean {
    return [...this.active.values()].some((active) => active.run.scheduleId === scheduleId) || this.repo.active(scheduleId);
  }

  private consumeDue(at: number, skip: boolean): void {
    for (const schedule of this.repo.due(at)) {
      if (this.closed || this.deletingWorkspaces.has(schedule.workspaceId) || this.deletingSchedules.has(schedule.id)) continue;
      const scheduledAt = schedule.nextRunAt;
      if (scheduledAt === null) continue;
      const reason = skip ? 'Daemon was offline or its clock/heartbeat was interrupted; slot skipped.'
        : at - scheduledAt > STALE_SLOT_MS ? 'Execution slot is stale; slot skipped.'
          : this.isBusy(schedule.id) ? 'Previous execution is still active; slot skipped.'
            : this.active.size >= MAX_ACTIVE ? 'All four execution slots are busy; slot skipped.' : null;
      const run = this.makeRun(schedule, 'scheduled', scheduledAt, reason !== null);
      run.error = reason;
      this.db.transaction(() => {
        this.repo.advance(schedule, at, nextScheduleRun(schedule.cronExpression, schedule.timeZone, at));
        this.repo.insertRun(run);
      })();
      if (reason === null) this.launch(run, schedule.timeoutMs);
      this.queueCleanup(run);
    }
  }

  private makeRun(schedule: Schedule, trigger: ScheduleRun['trigger'], scheduledAt: number, missed: boolean): ScheduleRun {
    const at = this.now();
    return {
      id: randomUUID(), scheduleId: schedule.id, workspaceId: schedule.workspaceId,
      scheduleName: schedule.name, task: schedule.task, trigger, status: missed ? 'missed' : 'running',
      scheduledAt, startedAt: missed ? null : at, finishedAt: missed ? at : null,
      sessionId: null, exitCode: null, error: null, output: '', outputTruncated: false,
    };
  }

  private launch(run: ScheduleRun, timeoutMs: number): void {
    const controller = new AbortController();
    const active: ActiveRun = {
      run, controller, timer: setTimeout(() => this.abort(active, 'timed_out'), timeoutMs),
      done: Promise.resolve(),
    };
    active.timer.unref();
    this.active.set(run.id, active);
    active.done = Promise.resolve().then(async () => {
      if (controller.signal.aborted || this.closed) return;
      try {
        this.executor.validate(run.workspaceId, run.task);
        const result = await this.executor.execute(run, controller.signal, (change) => this.updateRun(active, change));
        if (controller.signal.aborted || this.active.get(run.id) !== active || terminal(active.run)) return;
        active.run = {
          ...active.run, status: result.status, finishedAt: this.now(), exitCode: result.exitCode ?? null,
          error: result.error?.slice(0, 2_000) ?? null,
        };
        this.repo.updateActiveRun(active.run);
      } catch {
        if (!controller.signal.aborted && this.active.get(run.id) === active && !terminal(active.run)) {
          active.run = { ...active.run, status: 'failed', finishedAt: this.now(), error: 'Execution failed.' };
          this.repo.updateActiveRun(active.run);
        }
      }
    }).finally(() => {
      clearTimeout(active.timer);
      if (this.active.get(run.id) === active) this.active.delete(run.id);
      this.repo.releaseRun(active.run);
      this.queueCleanup(run);
    });
  }

  private updateRun(active: ActiveRun, change: ScheduleExecutionUpdate): void {
    if (this.closed || active.controller.signal.aborted || terminal(active.run) || this.active.get(active.run.id) !== active) return;
    let output = active.run.output;
    let outputTruncated = active.run.outputTruncated;
    if (change.output !== undefined) {
      outputTruncated ||= output.length + change.output.length > SCHEDULE_OUTPUT_MAX;
      output = change.output.length >= SCHEDULE_OUTPUT_MAX ? change.output.slice(-SCHEDULE_OUTPUT_MAX)
        : (output + change.output).slice(-SCHEDULE_OUTPUT_MAX);
    }
    active.run = {
      ...active.run, status: change.status ?? active.run.status,
      sessionId: change.sessionId ?? active.run.sessionId, output, outputTruncated,
    };
    this.repo.updateActiveRun(active.run);
  }

  private abort(active: ActiveRun, status: 'cancelled' | 'timed_out'): void {
    if (terminal(active.run)) return;
    active.run = {
      ...active.run, status, finishedAt: this.now(),
      error: status === 'timed_out' ? 'Execution deadline exceeded.' : null,
    };
    this.repo.updateActiveRun(active.run);
    active.controller.abort();
    clearTimeout(active.timer);
  }

  private queueCleanup(run: ScheduleRun): void {
    if (!this.pendingCleanup.has(run.scheduleId)) {
      this.pendingCleanup.set(run.scheduleId, { workspaceId: run.workspaceId, scheduleId: run.scheduleId, remove: false });
    }
    if (!this.closed) void this.cleanupHistory();
  }

  private cleanupHistory(): Promise<void> {
    if (this.cleanupTask !== undefined) return this.cleanupTask;
    if (this.closed || this.pendingCleanup.size === 0) return Promise.resolve();
    const queued = [...this.pendingCleanup.values()];
    this.cleanupTask = (async () => {
      for (const cleanup of queued) {
        if (this.closed) break;
        const { workspaceId, scheduleId, remove } = cleanup;
        this.pendingCleanup.delete(scheduleId);
        if (this.deletingWorkspaces.has(workspaceId)) continue;
        try {
          if (remove) {
            this.deletingSchedules.add(scheduleId);
            await this.cancelMatching((active) => active.run.scheduleId === scheduleId);
          }
          const runs = remove ? this.repo.allRuns(workspaceId, scheduleId) : this.repo.expiredRuns(workspaceId, scheduleId);
          for (const run of runs) {
            if (this.deletingWorkspaces.has(workspaceId)) break;
            if (!terminal(run)) throw busy();
            await this.executor.forget(run);
            this.repo.removeRun(run);
          }
          if (remove && !this.deletingWorkspaces.has(workspaceId)) {
            this.repo.remove(workspaceId, scheduleId);
            this.deletingSchedules.delete(scheduleId);
          }
        } catch {
          const pending = this.pendingCleanup.get(scheduleId);
          this.pendingCleanup.set(scheduleId, { ...cleanup, remove: remove || pending?.remove === true });
          this.warn('Schedule history cleanup failed; retained ownership for retry.');
        }
      }
    })().finally(() => { this.cleanupTask = undefined; });
    return this.cleanupTask;
  }

  private async cancelMatching(matches: (active: ActiveRun) => boolean): Promise<void> {
    const active = [...this.active.values()].filter(matches);
    for (const run of active) this.abort(run, 'cancelled');
    await Promise.all(active.map((run) => run.done));
  }
}
