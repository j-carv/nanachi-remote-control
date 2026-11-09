import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SchedulePreviewResponseSchema,
  ScheduleRunSchema,
  ScheduleRunsResponseSchema,
  ScheduleSchema,
  SchedulesResponseSchema,
  type ScheduleInput,
  type ScheduleRun,
} from '@nanachi/shared';
import { describe, expect, it, vi } from 'vitest';
import { countBusySessions, hasBusySessionsInWorkspace } from '../src/repository.js';
import { createWorkspace, fakeAgent, listen, pairToken } from './agent-support.js';
import { setupDaemonTests, type TestDaemon } from './support.js';

const env = setupDaemonTests();
const agentInput: ScheduleInput = {
  name: 'Synthetic task', cronExpression: '0 9 * * 1-5', timeZone: 'America/Sao_Paulo',
  enabled: false, timeoutMs: 60_000,
  task: { kind: 'agent', agentId: 'synthetic', accountId: 'default', model: '', prompt: 'Synthetic task only' },
};

async function boot(): Promise<{ daemon: TestDaemon; workspaceId: string; otherId: string; headers: { authorization: string } }> {
  const daemon = await env.start({ config: { allowedRoots: [env.home], agents: { synthetic: fakeAgent() } } });
  await mkdir(join(env.home, 'workspace'));
  await mkdir(join(env.home, 'other'));
  return {
    daemon, workspaceId: await createWorkspace(daemon, join(env.home, 'workspace')),
    otherId: await createWorkspace(daemon, join(env.home, 'other')),
    headers: { authorization: `Bearer ${await pairToken(daemon)}` },
  };
}

describe('protected workspace schedule API', () => {
  it('provides canonical persisted CRUD and five real preview slots without starting agent work', async () => {
    const { daemon, workspaceId, headers } = await boot();
    const url = `/api/workspaces/${workspaceId}/schedules`;
    const created = await daemon.app.inject({ method: 'POST', url, headers, payload: agentInput });
    expect(created.statusCode).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const schedule = ScheduleSchema.parse(created.json<unknown>());
    expect(schedule).toMatchObject({ workspaceId, enabled: false, nextRunAt: null });
    const listed = await daemon.app.inject({ method: 'GET', url, headers });
    expect(SchedulesResponseSchema.parse(listed.json<unknown>()).schedules).toEqual([schedule]);
    const preview = await daemon.app.inject({
      method: 'POST', url: `${url}/preview`, headers,
      payload: { cronExpression: '0 0 29 2 *', timeZone: 'UTC' },
    });
    expect(preview.statusCode).toBe(200);
    const { nextRuns } = SchedulePreviewResponseSchema.parse(preview.json<unknown>());
    expect(nextRuns.every((at) => at > Date.now())).toBe(true);
    expect(new Date(nextRuns[0]!).getUTCMonth()).toBe(1);
    const edited = await daemon.app.inject({ method: 'PUT', url: `${url}/${schedule.id}`, headers, payload: { ...agentInput, enabled: true } });
    expect(edited.statusCode).toBe(200);
    expect(ScheduleSchema.parse(edited.json<unknown>())).toMatchObject({ id: schedule.id, enabled: true, nextRunAt: expect.any(Number) });
    const history = await daemon.app.inject({ method: 'GET', url: `${url}/${schedule.id}/runs`, headers });
    expect(ScheduleRunsResponseSchema.parse(history.json<unknown>())).toEqual({ runs: [] });
    expect((await daemon.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/sessions`, headers })).json()).toEqual({ sessions: [] });
    expect((await daemon.app.inject({ method: 'DELETE', url: `${url}/${schedule.id}`, headers })).statusCode).toBe(204);
    expect((await daemon.app.inject({ method: 'GET', url, headers })).json()).toEqual({ schedules: [] });
  });

  it('requires paired auth on every endpoint, keeps Host defenses and scopes schedule/run IDs', async () => {
    const { daemon, workspaceId, otherId, headers } = await boot();
    const url = `/api/workspaces/${workspaceId}/schedules`;
    const response = await daemon.app.inject({ method: 'POST', url, headers, payload: agentInput });
    const schedule = ScheduleSchema.parse(response.json<unknown>());
    const protectedRoutes = [
      ['GET', url], ['POST', url], ['POST', `${url}/preview`], ['GET', `${url}/models?agentId=synthetic`],
      ['PUT', `${url}/${schedule.id}`], ['DELETE', `${url}/${schedule.id}`], ['POST', `${url}/${schedule.id}/run`],
      ['GET', `${url}/${schedule.id}/runs`], ['GET', `${url}/${schedule.id}/runs/unknown`],
      ['POST', `${url}/${schedule.id}/runs/unknown/cancel`],
    ] as const;
    for (const [method, path] of protectedRoutes) {
      expect((await daemon.app.inject({ method, url: path })).statusCode).toBe(401);
    }
    const badHost = await daemon.app.inject({ method: 'GET', url, headers: { ...headers, host: 'attacker.invalid' } });
    expect(badHost.statusCode).toBe(403);
    expect(badHost.json()).toEqual({ error: 'bad_host' });
    const other = `/api/workspaces/${otherId}/schedules/${schedule.id}`;
    for (const [method, path] of [['PUT', other], ['DELETE', other], ['POST', `${other}/run`], ['GET', `${other}/runs`], ['GET', `${other}/runs/unknown`]] as const) {
      const result = await daemon.app.inject({ method, url: path, headers, ...(method === 'PUT' ? { payload: agentInput } : {}) });
      expect(result.statusCode).toBe(404);
      expect(result.json()).toEqual({ error: 'not_found' });
    }
  });

  it('rejects unknown fields, invalid calendars/timezones and malformed model queries even while paused', async () => {
    const { daemon, workspaceId, headers } = await boot();
    const url = `/api/workspaces/${workspaceId}/schedules`;
    for (const payload of [
      { ...agentInput, cronExpression: '0 0 31 2 *' },
      { ...agentInput, timeZone: 'invalid/zone' },
      { ...agentInput, timeoutMs: 999 },
      { ...agentInput, permissions: 'yolo' },
      { ...agentInput, task: { ...agentInput.task, env: { SECRET: 'synthetic' } } },
    ]) {
      const result = await daemon.app.inject({ method: 'POST', url, headers, payload });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toEqual({ error: 'invalid_request' });
    }
    for (const query of ['', '?agentId=synthetic&accountId=a&accountId=b', '?agentId=synthetic&secret=x']) {
      const result = await daemon.app.inject({ method: 'GET', url: `${url}/models${query}`, headers });
      expect(result.statusCode).toBe(400);
    }
    const missing = await daemon.app.inject({ method: 'GET', url: '/api/workspaces/missing/schedules', headers });
    expect(missing.statusCode).toBe(404);
  });
});

describe.skipIf(process.platform !== 'win32')('real loopback scheduled command API', () => {
  async function commandFixture(command: string, timeoutMs = 10_000) {
    const fixture = await boot();
    const baseUrl = await listen(fixture.daemon);
    const url = `${baseUrl}/api/workspaces/${fixture.workspaceId}/schedules`;
    const response = await fetch(url, {
      method: 'POST', headers: { ...fixture.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...agentInput, timeoutMs, task: { kind: 'command', shell: 'cmd', command } }),
    });
    expect(response.status).toBe(201);
    const schedule = ScheduleSchema.parse(await response.json());
    return { ...fixture, baseUrl, url: `${url}/${schedule.id}`, schedule };
  }

  async function waitForRun(url: string, headers: { authorization: string }, predicate: (run: ScheduleRun) => boolean) {
    let result: ScheduleRun | undefined;
    await vi.waitFor(async () => {
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200);
      result = ScheduleRunSchema.parse(await response.json());
      expect(predicate(result)).toBe(true);
    }, { timeout: 10_000, interval: 40 });
    return result!;
  }

  it('executes an owner-entered command with real stdout/stderr, zero/nonzero exits and no chat sessions', async () => {
    const fixture = await commandFixture('echo schedule-success & echo synthetic-stderr 1>&2 & exit /b 0');
    const accepted = await fetch(`${fixture.url}/run`, { method: 'POST', headers: fixture.headers });
    expect(accepted.status).toBe(202);
    const run = ScheduleRunSchema.parse(await accepted.json());
    const finished = await waitForRun(`${fixture.url}/runs/${run.id}`, fixture.headers, (value) => value.status === 'succeeded');
    expect(finished).toMatchObject({ exitCode: 0, trigger: 'manual', sessionId: null });
    expect(finished.output).toContain('schedule-success');
    expect(finished.output).toContain('synthetic-stderr');
    const sessions = await fetch(`${fixture.baseUrl}/api/workspaces/${fixture.workspaceId}/sessions`, { headers: fixture.headers });
    expect(await sessions.json()).toEqual({ sessions: [] });
    const edit = await fetch(fixture.url, {
      method: 'PUT', headers: { ...fixture.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...agentInput, task: { kind: 'command', shell: 'cmd', command: 'exit /b 17' } }),
    });
    expect(edit.status).toBe(200);
    const second = await fetch(`${fixture.url}/run`, { method: 'POST', headers: fixture.headers });
    const failed = ScheduleRunSchema.parse(await second.json());
    expect(await waitForRun(`${fixture.url}/runs/${failed.id}`, fixture.headers, (value) => value.status === 'failed')).toMatchObject({ exitCode: 17 });
  });

  it('counts command work for reload/branch safety, rejects overlap and supports idempotent process cancellation', async () => {
    const fixture = await commandFixture('echo command-started & ping -n 31 127.0.0.1 >NUL');
    const accepted = await fetch(`${fixture.url}/run`, { method: 'POST', headers: fixture.headers });
    const run = ScheduleRunSchema.parse(await accepted.json());
    await waitForRun(`${fixture.url}/runs/${run.id}`, fixture.headers, (value) => value.output.includes('command-started'));
    expect(countBusySessions(fixture.daemon.db)).toBe(1);
    expect(hasBusySessionsInWorkspace(fixture.daemon.db, fixture.workspaceId)).toBe(true);
    const overlapping = await fetch(`${fixture.url}/run`, { method: 'POST', headers: fixture.headers });
    expect(overlapping.status).toBe(409);
    expect(await overlapping.json()).toEqual({ error: 'busy' });
    for (let index = 0; index < 2; index++) {
      const cancelled = await fetch(`${fixture.url}/runs/${run.id}/cancel`, { method: 'POST', headers: fixture.headers });
      expect(cancelled.status).toBe(200);
      expect(ScheduleRunSchema.parse(await cancelled.json()).status).toBe('cancelled');
    }
    expect(countBusySessions(fixture.daemon.db)).toBe(0);
    expect(hasBusySessionsInWorkspace(fixture.daemon.db, fixture.workspaceId)).toBe(false);
  });

  it('times out real commands and cancels command work before workspace deletion', async () => {
    const fixture = await commandFixture('echo command-started & ping -n 31 127.0.0.1 >NUL', 1_000);
    const accepted = await fetch(`${fixture.url}/run`, { method: 'POST', headers: fixture.headers });
    const run = ScheduleRunSchema.parse(await accepted.json());
    expect(await waitForRun(`${fixture.url}/runs/${run.id}`, fixture.headers, (value) => value.status === 'timed_out')).toMatchObject({ status: 'timed_out' });
    const joined = await fetch(`${fixture.url}/runs/${run.id}/cancel`, { method: 'POST', headers: fixture.headers });
    expect(ScheduleRunSchema.parse(await joined.json()).status).toBe('timed_out');
    const second = await fetch(`${fixture.url}/run`, { method: 'POST', headers: fixture.headers });
    const current = ScheduleRunSchema.parse(await second.json());
    await waitForRun(`${fixture.url}/runs/${current.id}`, fixture.headers, (value) => value.output.includes('command-started'));
    const removed = await fetch(`${fixture.baseUrl}/api/workspaces/${fixture.workspaceId}`, { method: 'DELETE', headers: fixture.headers });
    expect(removed.status).toBe(204);
    expect(countBusySessions(fixture.daemon.db)).toBe(0);
    const missing = await fetch(`${fixture.url}/runs/${current.id}`, { headers: fixture.headers });
    expect(missing.status).toBe(404);
  });
});
