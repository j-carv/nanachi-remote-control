import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduleInput, ScheduleRun } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../src/db.js';
import { countBusySessions, hasBusySessionsInWorkspace, insertWorkspace } from '../src/repository.js';
import type { ScheduleExecutionResult, ScheduleExecutionUpdate, ScheduleExecutor } from '../src/schedule-execution.js';
import { ScheduleRepository } from '../src/schedule-repository.js';
import { ScheduleService } from '../src/schedule-service.js';
import { removeTempDir } from './temp.js';

interface Execution {
  run: ScheduleRun;
  signal: AbortSignal;
  update(change: ScheduleExecutionUpdate): void;
  finish(result: ScheduleExecutionResult): void;
}

class Executor implements ScheduleExecutor {
  readonly executions: Execution[] = [];
  holdAbort = false;
  rejected = false;
  readonly forgotten: ScheduleRun[] = [];
  cleanupFails = false;

  validate(): void {
    if (this.rejected) throw new Error('configuration is no longer allowed');
  }

  execute(run: ScheduleRun, signal: AbortSignal, update: (change: ScheduleExecutionUpdate) => void): Promise<ScheduleExecutionResult> {
    return new Promise((finish) => {
      this.executions.push({ run, signal, update, finish });
      signal.addEventListener('abort', () => {
        if (!this.holdAbort) finish({ status: 'failed' });
      }, { once: true });
    });
  }

  models(): Promise<{ models: []; currentModel: null; supported: false }> {
    return Promise.resolve({ models: [], currentModel: null, supported: false });
  }

  forget(run: ScheduleRun): Promise<void> {
    if (this.cleanupFails) return Promise.reject(new Error('synthetic cleanup failure'));
    this.forgotten.push(run);
    return Promise.resolve();
  }
}

const input: ScheduleInput = {
  name: 'Synthetic maintenance', cronExpression: '* * * * *', timeZone: 'UTC', enabled: true,
  timeoutMs: 600_000, task: { kind: 'command', shell: 'cmd', command: 'echo synthetic' },
};

let dir: string;
let db: Database.Database;
let service: ScheduleService;
let executor: Executor;
let now: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
  dir = await mkdtemp(join(tmpdir(), 'nanachi-scheduler-'));
  db = openDatabase(join(dir, 'data.db'));
  now = Date.UTC(2026, 0, 1);
  for (const id of ['workspace', 'other']) {
    insertWorkspace(db, { id, name: id, path: join(dir, id), createdAt: now, muted: false });
  }
  executor = new Executor();
  service = new ScheduleService({ db, executor, now: () => now });
});

afterEach(async () => {
  for (const execution of executor.executions) execution.finish({ status: 'failed' });
  await service.close();
  db.close();
  vi.useRealTimers();
  await removeTempDir(dir);
});

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function heartbeatUntil(at: number): void {
  while (now < at) {
    now = Math.min(at, now + 5_000);
    service.tick();
  }
}

describe('ScheduleService', () => {
  it('persists paused-by-default schedules, validates calendars even when paused, and scopes every resource', () => {
    const schedule = service.create('workspace', { ...input, enabled: undefined });
    expect(schedule).toMatchObject({ enabled: false, nextRunAt: null });
    expect(service.list('workspace')).toEqual([schedule]);
    expect(service.preview('workspace', { cronExpression: '0 0 29 2 *', timeZone: 'UTC' })).toHaveLength(5);
    expect(() => service.create('workspace', { ...input, cronExpression: '0 0 31 2 *', enabled: false })).toThrow();
    expect(() => service.create('workspace', { ...input, task: { ...input.task, env: {} } })).toThrow();
    expect(() => service.update('other', schedule.id, input)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => service.runs('other', schedule.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => service.preview('missing', { cronExpression: '* * * * *', timeZone: 'UTC' })).toThrow(expect.objectContaining({ status: 404 }));
    executor.rejected = true;
    expect(() => service.create('workspace', input)).toThrow('configuration is no longer allowed');
  });

  it('enforces the durable 100-schedule workspace limit without affecting other workspaces', () => {
    for (let index = 0; index < 100; index++) service.create('workspace', input);
    expect(() => service.create('workspace', input)).toThrow(expect.objectContaining({ code: 'schedule_limit' }));
    expect(service.list('workspace')).toHaveLength(100);
    expect(service.create('other', input).workspaceId).toBe('other');
  });

  it('reserves and advances a due slot before work starts, never overlaps, and preserves the in-flight snapshot on edit', async () => {
    const schedule = service.create('workspace', input);
    service.start();
    heartbeatUntil(now + 60_000);
    expect(service.list('workspace')[0]?.nextRunAt).toBe(now + 60_000);
    await flush();
    expect(executor.executions).toHaveLength(1);
    const execution = executor.executions[0]!;
    service.update('workspace', schedule.id, { ...input, name: 'Changed', enabled: false, task: { ...input.task, command: 'echo changed' } });
    expect(execution.run).toMatchObject({ scheduleName: input.name, task: input.task });
    expect(() => service.runNow('workspace', schedule.id)).toThrow(expect.objectContaining({ status: 409, code: 'busy' }));
    service.update('workspace', schedule.id, input);
    heartbeatUntil(now + 60_000);
    expect(service.runs('workspace', schedule.id)[0]).toMatchObject({ status: 'missed', error: expect.stringContaining('Previous execution') });
    expect(executor.executions).toHaveLength(1);
    execution.finish({ status: 'succeeded', exitCode: 0 });
    await flush();
    expect(service.run('workspace', schedule.id, execution.run.id).status).toBe('succeeded');
  });

  it('allows manual execution while paused but caps all kinds of work at four without queueing catch-up', async () => {
    const schedules = Array.from({ length: 5 }, (_, index) => service.create('workspace', {
      ...input, name: `Task ${index}`, enabled: false,
      task: index % 2 === 0 ? input.task : { kind: 'agent', agentId: 'synthetic', accountId: 'default', model: '', prompt: 'Synthetic' },
    }));
    service.start();
    const runs = schedules.slice(0, 4).map((schedule) => service.runNow('workspace', schedule.id));
    expect(() => service.runNow('workspace', schedules[4]!.id)).toThrow(expect.objectContaining({ code: 'busy' }));
    await flush();
    expect(executor.executions).toHaveLength(4);
    expect(runs.every((run) => run.trigger === 'manual')).toBe(true);
    executor.executions[0]!.finish({ status: 'succeeded' });
    await flush();
    expect(service.runNow('workspace', schedules[4]!.id).status).toBe('running');
  });

  it('records exactly one earliest missed slot on startup and on a heartbeat gap, then resumes only future slots', async () => {
    const schedule = service.create('workspace', input);
    now += 5 * 60_000;
    service.start();
    expect(service.runs('workspace', schedule.id)).toEqual([
      expect.objectContaining({ status: 'missed', scheduledAt: schedule.nextRunAt }),
    ]);
    expect(executor.executions).toHaveLength(0);
    now += 5 * 60_000;
    service.tick();
    expect(service.runs('workspace', schedule.id)).toHaveLength(2);
    expect(executor.executions).toHaveLength(0);
    heartbeatUntil(now + 60_000);
    await flush();
    expect(executor.executions).toHaveLength(1);
    expect(service.runs('workspace', schedule.id)[0]?.status).toBe('running');
  });

  it('recovers permission-wait executions as interrupted and pauses only affected schedules', () => {
    const schedule = service.create('workspace', input);
    const unaffected = service.create('workspace', input);
    new ScheduleRepository(db).insertRun({
      id: 'previous-run', scheduleId: schedule.id, workspaceId: 'workspace', scheduleName: schedule.name,
      task: schedule.task, trigger: 'scheduled', status: 'awaiting_permission', scheduledAt: now - 1_000,
      startedAt: now - 1_000, finishedAt: null, sessionId: 'dedicated-session', exitCode: null,
      error: null, output: 'previous output', outputTruncated: false,
    });
    service.start();
    expect(service.run('workspace', schedule.id, 'previous-run')).toMatchObject({
      status: 'interrupted', finishedAt: now, output: 'previous output', sessionId: 'dedicated-session',
    });
    expect(service.list('workspace').find((item) => item.id === schedule.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(service.list('workspace').find((item) => item.id === unaffected.id)?.enabled).toBe(true);
    expect(executor.executions).toHaveLength(0);
  });

  it('persists bounded output, permission status, session ownership and nonzero failure result', async () => {
    const schedule = service.create('workspace', input);
    service.start();
    const run = service.runNow('workspace', schedule.id);
    await flush();
    const execution = executor.executions[0]!;
    execution.update({ output: 'prefix', status: 'awaiting_permission', sessionId: 'dedicated-session' });
    expect(service.run('workspace', schedule.id, run.id)).toMatchObject({ status: 'awaiting_permission', sessionId: 'dedicated-session' });
    execution.update({ output: 'x'.repeat(65_536) + 'tail' });
    execution.finish({ status: 'failed', exitCode: 17, error: 'Synthetic nonzero exit' });
    await flush();
    const finished = service.run('workspace', schedule.id, run.id);
    expect(finished).toMatchObject({ status: 'failed', exitCode: 17, outputTruncated: true, error: 'Synthetic nonzero exit' });
    expect(finished.output).toHaveLength(65_536);
    expect(finished.output.endsWith('tail')).toBe(true);
    execution.update({ output: 'late', status: 'running' });
    expect(service.run('workspace', schedule.id, run.id)).toEqual(finished);
  });

  it('includes startup and permission waits in deadlines and ignores all late completion callbacks', async () => {
    const schedule = service.create('workspace', { ...input, timeoutMs: 1_000 });
    service.start();
    const run = service.runNow('workspace', schedule.id);
    await flush();
    const execution = executor.executions[0]!;
    execution.update({ status: 'awaiting_permission' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execution.signal.aborted).toBe(true);
    expect(service.run('workspace', schedule.id, run.id)).toMatchObject({ status: 'timed_out', error: 'Execution deadline exceeded.' });
    execution.finish({ status: 'succeeded' });
    execution.update({ output: 'late' });
    await flush();
    expect(service.run('workspace', schedule.id, run.id)).toMatchObject({ status: 'timed_out', output: '' });
  });

  it('joins cancellation before deleting rows, bars new launches during deletion and never resurrects deleted work', async () => {
    executor.holdAbort = true;
    const schedule = service.create('workspace', input);
    service.start();
    const run = service.runNow('workspace', schedule.id);
    await flush();
    const execution = executor.executions[0]!;
    const removing = service.remove('workspace', schedule.id);
    expect(execution.signal.aborted).toBe(true);
    expect(countBusySessions(db)).toBe(1);
    expect(hasBusySessionsInWorkspace(db, 'workspace')).toBe(true);
    expect(() => service.runNow('workspace', schedule.id)).toThrow(expect.objectContaining({ status: 404 }));
    execution.update({ output: 'after-delete' });
    execution.finish({ status: 'succeeded' });
    await removing;
    expect(service.list('workspace')).toEqual([]);
    expect(countBusySessions(db)).toBe(0);
    expect(executor.forgotten).toEqual([expect.objectContaining({ id: run.id, status: 'cancelled' })]);
    expect(() => service.run('workspace', schedule.id, run.id)).toThrow(expect.objectContaining({ status: 404 }));
    execution.update({ status: 'running' });
    expect(service.list('workspace')).toEqual([]);
  });

  it('cancels idempotently, retains the latest 100 histories, and scopes run IDs to schedule and workspace', async () => {
    const schedule = service.create('workspace', input);
    const other = service.create('workspace', input);
    service.start();
    const first = service.runNow('workspace', schedule.id);
    await flush();
    await service.cancel('workspace', schedule.id, first.id);
    expect(await service.cancel('workspace', schedule.id, first.id)).toMatchObject({ status: 'cancelled' });
    expect(() => service.run('other', schedule.id, first.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => service.run('workspace', other.id, first.id)).toThrow(expect.objectContaining({ status: 404 }));
    for (let index = 0; index < 101; index++) {
      now++;
      service.runNow('workspace', schedule.id);
      await flush();
      executor.executions.at(-1)!.finish({ status: 'succeeded' });
      await flush();
    }
    expect(service.runs('workspace', schedule.id)).toHaveLength(100);
    expect(() => service.run('workspace', schedule.id, first.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(executor.forgotten).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id })]));
  });

  it('retains failed cleanup ownership and resumes pending schedule deletion after a restart', async () => {
    const schedule = service.create('workspace', input);
    service.start();
    const run = service.runNow('workspace', schedule.id);
    await flush();
    executor.executions[0]!.update({ sessionId: 'owned-synthetic-session' });
    executor.executions[0]!.finish({ status: 'succeeded' });
    await flush();
    executor.cleanupFails = true;
    await expect(service.remove('workspace', schedule.id)).rejects.toMatchObject({ code: 'cleanup_failed' });
    expect(service.list('workspace')[0]).toMatchObject({ enabled: false, nextRunAt: null });
    expect(new ScheduleRepository(db).findRun('workspace', schedule.id, run.id)).toMatchObject({
      status: 'succeeded', sessionId: 'owned-synthetic-session',
    });
    await service.close();
    db.close();
    db = openDatabase(join(dir, 'data.db'));
    executor.cleanupFails = false;
    service = new ScheduleService({ db, executor, now: () => now });
    service.start();
    await flush();
    expect(service.list('workspace')).toEqual([]);
    expect(executor.forgotten).toEqual([expect.objectContaining({ id: run.id, sessionId: 'owned-synthetic-session' })]);
  });

  it('keeps expired owned runs durable when cleanup fails and retries their cleanup', async () => {
    const schedule = service.create('workspace', input);
    const repo = new ScheduleRepository(db);
    for (let index = 0; index < 101; index++) {
      repo.insertRun({
        id: `historical-${index}`, scheduleId: schedule.id, workspaceId: 'workspace', scheduleName: schedule.name,
        task: schedule.task, trigger: 'manual', status: 'succeeded', scheduledAt: now + index,
        startedAt: now, finishedAt: now, sessionId: `owned-${index}`, exitCode: 0,
        error: null, output: '', outputTruncated: false,
      });
    }
    executor.cleanupFails = true;
    service.start();
    await flush();
    expect(service.runs('workspace', schedule.id)).toHaveLength(100);
    expect(service.run('workspace', schedule.id, 'historical-0').sessionId).toBe('owned-0');
    executor.cleanupFails = false;
    service.tick();
    await flush();
    expect(executor.forgotten).toEqual([expect.objectContaining({ id: 'historical-0' })]);
    expect(() => service.run('workspace', schedule.id, 'historical-0')).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('never prunes an older active run and still returns its cancellation when retention expires it', async () => {
    const schedule = service.create('workspace', input);
    service.start();
    const active = service.runNow('workspace', schedule.id);
    await flush();
    heartbeatUntil(now + 101 * 60_000);
    await flush();
    service.tick();
    await flush();
    expect(service.runs('workspace', schedule.id)).toHaveLength(100);
    expect(service.run('workspace', schedule.id, active.id).status).toBe('running');
    expect(executor.forgotten.some((run) => run.id === active.id)).toBe(false);
    expect(await service.cancel('workspace', schedule.id, active.id)).toMatchObject({ id: active.id, status: 'cancelled' });
  });

  it('cancels all workspace executions before removal and prevents any work after close', async () => {
    const one = service.create('workspace', input);
    const two = service.create('other', input);
    service.start();
    service.runNow('workspace', one.id);
    const otherRun = service.runNow('other', two.id);
    await flush();
    await service.removeWorkspace('workspace');
    expect(executor.executions[0]!.signal.aborted).toBe(true);
    expect(executor.executions[1]!.signal.aborted).toBe(false);
    expect(() => service.create('workspace', input)).toThrow(expect.objectContaining({ status: 404 }));
    await service.close();
    expect(executor.executions[1]!.signal.aborted).toBe(true);
    expect(new ScheduleRepository(db).findRun('other', two.id, otherRun.id)?.status).toBe('cancelled');
    now += 60_000;
    service.tick();
    service.start();
    expect(executor.executions).toHaveLength(2);
    expect(() => service.runNow('other', two.id)).toThrow(expect.objectContaining({ code: 'busy' }));
  });
});
