import {
  SCHEDULE_HISTORY_MAX,
  ScheduleRunSchema,
  ScheduleSchema,
  type Schedule,
  type ScheduleRun,
} from '@nanachi/shared';
import type Database from 'better-sqlite3';

export interface ScheduleCleanup {
  workspaceId: string;
  scheduleId: string;
  remove: boolean;
}

interface ScheduleRow {
  id: string;
  workspace_id: string;
  name: string;
  cron_expression: string;
  time_zone: string;
  enabled: number;
  timeout_ms: number;
  task_json: string;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  schedule_id: string;
  workspace_id: string;
  schedule_name: string;
  task_json: string;
  trigger: string;
  status: string;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  session_id: string | null;
  exit_code: number | null;
  error: string | null;
  output: string;
  output_truncated: number;
}

function scheduleOf(row: ScheduleRow): Schedule {
  return ScheduleSchema.parse({
    id: row.id, workspaceId: row.workspace_id, name: row.name,
    cronExpression: row.cron_expression, timeZone: row.time_zone,
    enabled: row.enabled === 1, timeoutMs: row.timeout_ms, task: JSON.parse(row.task_json) as unknown,
    nextRunAt: row.next_run_at, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function runOf(row: RunRow): ScheduleRun {
  return ScheduleRunSchema.parse({
    id: row.id, scheduleId: row.schedule_id, workspaceId: row.workspace_id,
    scheduleName: row.schedule_name, task: JSON.parse(row.task_json) as unknown,
    trigger: row.trigger, status: row.status, scheduledAt: row.scheduled_at,
    startedAt: row.started_at, finishedAt: row.finished_at, sessionId: row.session_id,
    exitCode: row.exit_code, error: row.error, output: row.output, outputTruncated: row.output_truncated === 1,
  });
}

/** Scoped persistence; terminal runs can never be changed by a late executor callback. */
export class ScheduleRepository {
  constructor(private readonly db: Database.Database) {}

  list(workspaceId: string): Schedule[] {
    return this.db.prepare<[string], ScheduleRow>(
      'SELECT * FROM schedules WHERE workspace_id = ? ORDER BY created_at, rowid',
    ).all(workspaceId).map(scheduleOf);
  }

  find(workspaceId: string, scheduleId: string): Schedule | undefined {
    const row = this.db.prepare<[string, string], ScheduleRow>(
      'SELECT * FROM schedules WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, scheduleId);
    return row === undefined ? undefined : scheduleOf(row);
  }

  insert(schedule: Schedule): void {
    this.db.prepare(`INSERT INTO schedules (
      id, workspace_id, name, cron_expression, time_zone, enabled, timeout_ms, task_json,
      next_run_at, created_at, updated_at
    ) VALUES (@id, @workspaceId, @name, @cronExpression, @timeZone, @enabled, @timeoutMs,
      @task, @nextRunAt, @createdAt, @updatedAt)`).run({
      ...schedule, enabled: schedule.enabled ? 1 : 0, task: JSON.stringify(schedule.task),
    });
  }

  update(schedule: Schedule): void {
    this.db.prepare(`UPDATE schedules SET name = @name, cron_expression = @cronExpression,
      time_zone = @timeZone, enabled = @enabled, timeout_ms = @timeoutMs, task_json = @task,
      next_run_at = @nextRunAt, updated_at = @updatedAt WHERE workspace_id = @workspaceId AND id = @id`).run({
      ...schedule, enabled: schedule.enabled ? 1 : 0, task: JSON.stringify(schedule.task),
    });
  }

  due(at: number): Schedule[] {
    return this.db.prepare<[number], ScheduleRow>(`SELECT * FROM schedules
      WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, rowid`).all(at).map(scheduleOf);
  }

  advance(schedule: Schedule, at: number, nextRunAt: number): void {
    this.db.prepare<[number, number, string, string]>(`UPDATE schedules SET next_run_at = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND enabled = 1`).run(nextRunAt, at, schedule.workspaceId, schedule.id);
  }

  active(scheduleId: string): boolean {
    return this.db.prepare<[string], { id: string }>(`SELECT id FROM schedule_runs
      WHERE schedule_id = ? AND execution_active = 1 LIMIT 1`).get(scheduleId) !== undefined;
  }

  insertRun(run: ScheduleRun): void {
    this.db.prepare(`INSERT INTO schedule_runs (
      id, schedule_id, workspace_id, schedule_name, task_json, trigger, status, execution_active, scheduled_at,
      started_at, finished_at, session_id, exit_code, error, output, output_truncated
    ) VALUES (@id, @scheduleId, @workspaceId, @scheduleName, @task, @trigger, @status, @executionActive, @scheduledAt,
      @startedAt, @finishedAt, @sessionId, @exitCode, @error, @output, @outputTruncated)`).run({
      ...run, task: JSON.stringify(run.task), outputTruncated: run.outputTruncated ? 1 : 0,
      executionActive: run.status === 'running' || run.status === 'awaiting_permission' ? 1 : 0,
    });
  }

  findRun(workspaceId: string, scheduleId: string, runId: string): ScheduleRun | undefined {
    const row = this.db.prepare<[string, string, string], RunRow>(`SELECT * FROM schedule_runs
      WHERE workspace_id = ? AND schedule_id = ? AND id = ?`).get(workspaceId, scheduleId, runId);
    return row === undefined ? undefined : runOf(row);
  }

  runs(workspaceId: string, scheduleId: string): ScheduleRun[] {
    return this.db.prepare<[string, string, number], RunRow>(`SELECT * FROM schedule_runs
      WHERE workspace_id = ? AND schedule_id = ? ORDER BY scheduled_at DESC, rowid DESC LIMIT ?`)
      .all(workspaceId, scheduleId, SCHEDULE_HISTORY_MAX).map(runOf);
  }

  updateActiveRun(run: ScheduleRun): boolean {
    const result = this.db.prepare(`UPDATE schedule_runs SET status = @status, finished_at = @finishedAt,
      session_id = @sessionId, exit_code = @exitCode, error = @error, output = @output,
      output_truncated = @outputTruncated WHERE workspace_id = @workspaceId AND schedule_id = @scheduleId
      AND id = @id AND status IN ('running', 'awaiting_permission')`).run({
      id: run.id, workspaceId: run.workspaceId, scheduleId: run.scheduleId, status: run.status,
      finishedAt: run.finishedAt, sessionId: run.sessionId, exitCode: run.exitCode,
      error: run.error, output: run.output, outputTruncated: run.outputTruncated ? 1 : 0,
    });
    return result.changes !== 0;
  }
  releaseRun(run: ScheduleRun): void {
    this.db.prepare<[string, string, string]>(`UPDATE schedule_runs SET execution_active = 0
      WHERE workspace_id = ? AND schedule_id = ? AND id = ?`).run(run.workspaceId, run.scheduleId, run.id);
  }


  recover(at: number): void {
    this.db.transaction(() => {
      this.db.prepare<[number]>(`UPDATE schedules SET enabled = 0, next_run_at = NULL, updated_at = ?
        WHERE id IN (SELECT schedule_id FROM schedule_runs WHERE execution_active = 1
          OR status IN ('running', 'awaiting_permission'))`).run(at);
      this.db.prepare<[number]>(`UPDATE schedule_runs SET status = 'interrupted', finished_at = ?,
        error = 'Daemon restarted during execution; schedule paused for review.'
        WHERE status IN ('running', 'awaiting_permission')`).run(at);
      this.db.prepare('UPDATE schedule_runs SET execution_active = 0 WHERE execution_active = 1').run();
    })();
  }

  remove(workspaceId: string, scheduleId: string): void {
    this.db.transaction(() => {
      this.db.prepare<[string, string]>('DELETE FROM schedule_runs WHERE workspace_id = ? AND schedule_id = ?').run(workspaceId, scheduleId);
      this.db.prepare<[string, string]>('DELETE FROM schedules WHERE workspace_id = ? AND id = ?').run(workspaceId, scheduleId);
    })();
  }

  removeWorkspace(workspaceId: string): void {
    this.db.transaction(() => {
      this.db.prepare<[string]>('DELETE FROM schedule_runs WHERE workspace_id = ?').run(workspaceId);
      this.db.prepare<[string]>('DELETE FROM schedules WHERE workspace_id = ?').run(workspaceId);
    })();
  }

  cleanupKeys(): ScheduleCleanup[] {
    return this.db.prepare<[], { workspace_id: string; id: string; deletion_pending: number }>(`SELECT
      workspace_id, id, deletion_pending FROM schedules WHERE deletion_pending = 1
      OR id IN (SELECT schedule_id FROM schedule_runs GROUP BY schedule_id HAVING COUNT(*) > ${SCHEDULE_HISTORY_MAX})`)
      .all().map((row) => ({ workspaceId: row.workspace_id, scheduleId: row.id, remove: row.deletion_pending === 1 }));
  }

  expiredRuns(workspaceId: string, scheduleId: string): ScheduleRun[] {
    return this.db.prepare<[string, string, string, string, number], RunRow>(`SELECT * FROM schedule_runs
      WHERE workspace_id = ? AND schedule_id = ? AND execution_active = 0 AND status NOT IN ('running', 'awaiting_permission')
      AND id NOT IN (SELECT id FROM schedule_runs WHERE workspace_id = ? AND schedule_id = ?
        ORDER BY scheduled_at DESC, rowid DESC LIMIT ?) ORDER BY scheduled_at, rowid`)
      .all(workspaceId, scheduleId, workspaceId, scheduleId, SCHEDULE_HISTORY_MAX).map(runOf);
  }

  allRuns(workspaceId: string, scheduleId: string): ScheduleRun[] {
    return this.db.prepare<[string, string], RunRow>(
      'SELECT * FROM schedule_runs WHERE workspace_id = ? AND schedule_id = ? ORDER BY scheduled_at, rowid',
    ).all(workspaceId, scheduleId).map(runOf);
  }

  removeRun(run: ScheduleRun): void {
    this.db.prepare<[string, string, string]>(`DELETE FROM schedule_runs WHERE workspace_id = ?
      AND schedule_id = ? AND id = ? AND execution_active = 0 AND status NOT IN ('running', 'awaiting_permission')`)
      .run(run.workspaceId, run.scheduleId, run.id);
  }

  markDeleting(workspaceId: string, scheduleId: string, at: number): void {
    this.db.prepare<[number, string, string]>(`UPDATE schedules SET deletion_pending = 1, enabled = 0,
      next_run_at = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`).run(at, workspaceId, scheduleId);
  }
}
