import { describe, expect, it } from 'vitest';
import type { Schedule, ScheduleInput, ScheduleRun } from '@nanachi/shared';
import { createApiClient, type ApiClient, type FetchLike } from './api.js';

const workspaceId = 'workspace /?#á';
const scheduleId = 'schedule /?#β';
const runId = 'run /?#γ';
const root = `/api/workspaces/${encodeURIComponent(workspaceId)}/schedules`;
const detail = `${root}/${encodeURIComponent(scheduleId)}`;
const runPath = `${detail}/runs/${encodeURIComponent(runId)}`;
const agent: ScheduleInput = {
  name: 'Agent report', cronExpression: '0 9 * * 1-5', timeZone: 'America/Sao_Paulo',
  enabled: false, timeoutMs: 600_000,
  task: { kind: 'agent', agentId: 'omp', accountId: 'default', model: 'chosen-model', prompt: 'Write the report' },
};
const command: ScheduleInput = {
  ...agent, name: 'Command report', task: { kind: 'command', shell: 'powershell', command: 'Write-Output report' },
};
function schedule(input: ScheduleInput): Schedule {
  return { ...input, id: scheduleId, workspaceId, nextRunAt: null, createdAt: 100, updatedAt: 200 };
}
function run(input: ScheduleInput): ScheduleRun {
  return {
    id: runId, scheduleId, workspaceId, scheduleName: input.name, task: input.task,
    trigger: 'manual', status: 'running', scheduledAt: 300, startedAt: 301,
    finishedAt: null, sessionId: input.task.kind === 'agent' ? 'automation-session' : null,
    exitCode: null, error: null, output: 'actual execution output', outputTruncated: false,
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function harness(responses: Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected network call');
    return response;
  };
  return { client: createApiClient({ baseUrl: 'http://localhost:7777/', token: 'paired-token' }, fetchFn), calls };
}

for (const input of [agent, command]) {
  describe(`schedule API: ${input.task.kind}`, () => {
    it('uses scoped canonical mutation endpoints and returns validated daemon state', async () => {
      const saved = { ...schedule(input), name: 'Daemon-confirmed name', enabled: true, nextRunAt: 400 };
      const updated = { ...saved, name: 'Daemon-confirmed update', updatedAt: 500 };
      const { client, calls } = harness([json(saved, 201), json(updated), json({ schedules: [updated] }), new Response(null, { status: 204 })]);
      expect(await client.createSchedule(workspaceId, input)).toEqual(saved);
      expect(await client.updateSchedule(workspaceId, scheduleId, input)).toEqual(updated);
      expect(await client.listSchedules(workspaceId)).toEqual([updated]);
      expect(await client.deleteSchedule(workspaceId, scheduleId)).toBeUndefined();
      expect(calls.map(({ url, init }) => [url, init?.method])).toEqual([
        [`http://localhost:7777${root}`, 'POST'], [`http://localhost:7777${detail}`, 'PUT'],
        [`http://localhost:7777${root}`, 'GET'], [`http://localhost:7777${detail}`, 'DELETE'],
      ]);
      for (const call of calls) expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer paired-token');
      for (const call of calls.slice(0, 2)) {
        expect(JSON.parse(String(call.init?.body))).toEqual(input);
        expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
      }
    });

    it('returns run snapshots, newest history, individual detail and confirmed cancellation', async () => {
      const started = run(input);
      const cancelled = { ...started, status: 'cancelled', finishedAt: 600, output: 'stopped by owner' };
      const { client, calls } = harness([json(started, 202), json({ runs: [cancelled, started] }), json(started), json(cancelled)]);
      expect(await client.runSchedule(workspaceId, scheduleId)).toEqual(started);
      expect(await client.scheduleRuns(workspaceId, scheduleId)).toEqual([cancelled, started]);
      expect(await client.scheduleRun(workspaceId, scheduleId, runId)).toEqual(started);
      expect(await client.cancelScheduleRun(workspaceId, scheduleId, runId)).toEqual(cancelled);
      expect(calls.map(({ url, init }) => [new URL(url).pathname, init?.method, init?.body])).toEqual([
        [`${detail}/run`, 'POST', undefined], [`${detail}/runs`, 'GET', undefined],
        [runPath, 'GET', undefined], [`${runPath}/cancel`, 'POST', undefined],
      ]);
    });
  });
}

describe('schedule API boundaries', () => {
  it('previews five timestamps and discovers models with escaped explicit agent/account queries', async () => {
    const nextRuns = [1000, 2000, 3000, 4000, 5000];
    const catalog = { models: [{ id: 'provider/model', name: 'Provider Model' }], currentModel: 'provider/model', supported: true };
    const { client, calls } = harness([json({ nextRuns }), json(catalog), json({ models: [], currentModel: null, supported: false })]);
    const timing = { cronExpression: agent.cronExpression, timeZone: agent.timeZone };
    expect(await client.previewSchedule(workspaceId, timing)).toEqual(nextRuns);
    expect(await client.scheduleModels(workspaceId, 'agent &?#', 'account +/á')).toEqual(catalog);
    expect(await client.scheduleModels(workspaceId, 'omp', 'default')).toEqual({ models: [], currentModel: null, supported: false });
    expect(new URL(calls[0]!.url).pathname).toBe(`${root}/preview`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(timing);
    const url = new URL(calls[1]!.url);
    expect(url.pathname).toBe(`${root}/models`);
    expect(calls[1]!.init?.method).toBe('GET');
    expect(Object.fromEntries(url.searchParams)).toEqual({ agentId: 'agent &?#', accountId: 'account +/á' });
  });

  it('fetches an automation session directly without consulting ordinary session lists', async () => {
    const session = { id: 'session /?#', workspaceId, agent: 'omp', kind: 'acp', title: 'Execution', status: 'idle', accountId: null, worktree: null, createdAt: 100, updatedAt: 200, automationRunId: runId };
    const { client, calls } = harness([json(session)]);
    expect(await client.fetchSession(session.id)).toEqual(session);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe(`/api/sessions/${encodeURIComponent(session.id)}`);
    expect(calls[0]!.init?.method).toBe('GET');
  });

  it('rejects schema-invalid mutations, timing and model queries before network access', async () => {
    const { client, calls } = harness([]);
    for (const invalid of [
      { ...agent, name: '' }, { ...agent, timeoutMs: 1 },
      { ...agent, task: { ...agent.task, permission: 'allow' } },
      { ...command, task: { kind: 'command', shell: 'invalid', command: 'echo x' } },
      { ...command, task: { kind: 'command', shell: 'powershell', command: ' ' } },
    ]) {
      await expect(client.createSchedule(workspaceId, invalid as ScheduleInput)).rejects.toMatchObject({ kind: 'invalid_input' });
      await expect(client.updateSchedule(workspaceId, scheduleId, invalid as ScheduleInput)).rejects.toMatchObject({ kind: 'invalid_input' });
    }
    await expect(client.previewSchedule(workspaceId, { cronExpression: '', timeZone: 'UTC' })).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(client.scheduleModels(workspaceId, '', 'default')).rejects.toMatchObject({ kind: 'invalid_input' });
    await expect(client.scheduleModels(workspaceId, 'omp', 'x'.repeat(201))).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  const operations: [string, (client: ApiClient) => Promise<unknown>][] = [
    ['list', c => c.listSchedules(workspaceId)],
    ['create', c => c.createSchedule(workspaceId, agent)],
    ['update', c => c.updateSchedule(workspaceId, scheduleId, command)],
    ['preview', c => c.previewSchedule(workspaceId, { cronExpression: '0 * * * *', timeZone: 'UTC' })],
    ['models', c => c.scheduleModels(workspaceId, 'omp', 'default')],
    ['run', c => c.runSchedule(workspaceId, scheduleId)],
    ['history', c => c.scheduleRuns(workspaceId, scheduleId)],
    ['detail', c => c.scheduleRun(workspaceId, scheduleId, runId)],
    ['cancel', c => c.cancelScheduleRun(workspaceId, scheduleId, runId)],
    ['session', c => c.fetchSession('session')],
  ];
  for (const [name, invoke] of operations) {
    it(`${name} rejects invalid daemon response shapes and malformed JSON`, async () => {
      await expect(invoke(harness([json({})]).client)).rejects.toMatchObject({ kind: 'unexpected', status: 200 });
      await expect(invoke(harness([new Response('not json', { status: 200 })]).client)).rejects.toMatchObject({ kind: 'unexpected', status: 200 });
    });
  }
  for (const [name, invoke] of [...operations, ['delete', (c: ApiClient) => c.deleteSchedule(workspaceId, scheduleId)] as const]) {
    it(`${name} preserves typed HTTP errors and maps transport failure without retries`, async () => {
      for (const [status, code, kind] of [[400, 'invalid_request', 'invalid_input'], [404, 'not_found', 'not_found'], [409, 'busy', 'busy']] as const) {
        const { client, calls } = harness([json({ error: code }, status)]);
        await expect(invoke(client)).rejects.toMatchObject({ kind, status, code });
        expect(calls).toHaveLength(1);
      }
      let calls = 0;
      const client = createApiClient({ baseUrl: 'http://localhost:7777', token: 'token' }, async () => { calls++; throw new TypeError('offline'); });
      await expect(invoke(client)).rejects.toMatchObject({ kind: 'network', status: null });
      expect(calls).toBe(1);
    });
  }

  it('rejects empty scoped IDs before sending a request', async () => {
    const { client, calls } = harness([]);
    const requests = [
      client.listSchedules(''), client.createSchedule('', agent), client.updateSchedule(workspaceId, '', agent),
      client.deleteSchedule('', scheduleId), client.previewSchedule('', { cronExpression: '* * * * *', timeZone: 'UTC' }),
      client.scheduleModels('', 'omp', 'default'), client.runSchedule(workspaceId, ''),
      client.scheduleRuns('', scheduleId), client.scheduleRun(workspaceId, scheduleId, ''),
      client.cancelScheduleRun(workspaceId, '', runId), client.fetchSession(''),
    ];
    await Promise.all(requests.map(request => expect(request).rejects.toMatchObject({ kind: 'invalid_input' })));
    expect(calls).toHaveLength(0);
  });

  it('rejects invalid nested tasks, preview length, model catalog and run output limits', async () => {
    await expect(harness([json({ schedules: [{ ...schedule(agent), task: { kind: 'agent' } }] })]).client.listSchedules(workspaceId)).rejects.toMatchObject({ kind: 'unexpected' });
    await expect(harness([json({ nextRuns: [1, 2, 3, 4] })]).client.previewSchedule(workspaceId, { cronExpression: '* * * * *', timeZone: 'UTC' })).rejects.toMatchObject({ kind: 'unexpected' });
    await expect(harness([json({ models: [{ id: '', name: 'bad' }], currentModel: null, supported: true })]).client.scheduleModels(workspaceId, 'omp', 'default')).rejects.toMatchObject({ kind: 'unexpected' });
    await expect(harness([json({ ...run(command), output: 'x'.repeat(65_537) })]).client.scheduleRun(workspaceId, scheduleId, runId)).rejects.toMatchObject({ kind: 'unexpected' });
  });
});
