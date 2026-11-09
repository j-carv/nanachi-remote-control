import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, type ScheduleRun, type ScheduleTask, type ServerMessage, type ShellId } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountLauncher, type AccountLauncher } from '../src/accounts/launch.js';
import type { LoadedConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import {
  countBusySessions, countLiveSessions, findSessionById, findSessionConfigOptions, insertAgentProfile, insertEvent, insertSession, insertWorkspace,
  hasBusySessionsInWorkspace, listAllSessionsByWorkspace, listEvents, listSessionsByWorkspace, searchSessionMessages, setActiveAccountId,
} from '../src/repository.js';
import { createScheduleExecutor } from '../src/schedule-runner.js';
import type { ScheduleExecutionUpdate, ScheduleExecutor } from '../src/schedule-execution.js';
import { ScheduleRepository } from '../src/schedule-repository.js';
import { SessionManager } from '../src/session-manager.js';
import { localShells } from '../src/shells.js';
import { fakeAgent, waitUntilDead } from './agent-support.js';
import { removeTempDir } from './temp.js';

let base: string;
let db: Database.Database;
let config: LoadedConfig;
let sessions: SessionManager;
let accounts: AccountLauncher;
let executor: ScheduleExecutor;
let logger: FastifyInstance;
let broadcasts: ServerMessage[];
const learned = vi.fn();

beforeEach(async () => {
  base = realpathSync.native(await mkdtemp(join(tmpdir(), 'nanachi-schedule-execution-')));
  await mkdir(join(base, 'workspace'));
  await mkdir(join(base, 'pids'));
  await mkdir(join(base, 'principal-claude'));
  db = openDatabase(join(base, 'data.db'));
  config = {
    ...ConfigSchema.parse({ allowedRoots: [base], agents: {
      fixture: fakeAgent({ FAKE_AGENT_PID_DIR: join(base, 'pids') }),
      claude: fakeAgent({ FAKE_AGENT_PID_DIR: join(base, 'pids'), CLAUDE_CONFIG_DIR: join(base, 'principal-claude') }),
      modes: fakeAgent({ FAKE_AGENT_STYLE: 'modes' }),
      stalled: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], label: 'No ACP response', kind: 'acp', env: {} },
    } }),
    machineName: 'Schedule tests',
  };
  insertWorkspace(db, { id: 'workspace', name: 'Synthetic', path: join(base, 'workspace'), createdAt: 1, muted: false });
  logger = fastify({ logger: false });
  accounts = createAccountLauncher({ db, agents: config.agents, nanachiHome: base, userHome: base, daemonEnv: {} });
  broadcasts = [];
  learned.mockClear();
  sessions = new SessionManager({
    db, config, log: logger.log, accounts, broadcast: (message) => broadcasts.push(message),
    agentApiUrl: () => 'http://127.0.0.1:9', worktreesRoot: join(base, 'worktrees'),
    filesRoot: join(base, 'files'), usageProbeRoot: join(base, 'probe'), appVersion: '0.0.0-test',
    agentListTimeoutMs: 2_000, onTurnCompleted: learned,
  });
  executor = createScheduleExecutor({ db, config, sessions, log: logger.log, filesRoot: join(base, 'files') });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await sessions.shutdown();
  await logger.close();
  db.close();
  await removeTempDir(base);
});

function run(task: ScheduleTask, id = 'run'): ScheduleRun {
  return {
    id, scheduleId: 'schedule', workspaceId: 'workspace', scheduleName: 'Synthetic task', task,
    trigger: 'manual', status: 'running', scheduledAt: 1, startedAt: 1, finishedAt: null,
    sessionId: null, exitCode: null, error: null, output: '', outputTruncated: false,
  };
}

function agentTask(prompt: string, model = '', agentId = 'fixture'): ScheduleTask {
  return { kind: 'agent', agentId, accountId: 'default', model, prompt };
}

async function methods(sessionId: string): Promise<string[]> {
  return (await readFile(join(base, 'pids', `${sessionId}.methods.jsonl`), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as string);
}

describe('scheduled ACP execution', () => {
  it('finishes the actual turn, preserves ownership before broadcasts, and keeps automation out of normal lists/search', async () => {
    insertSession(db, { id: 'ordinary', workspaceId: 'workspace', agent: 'fixture', title: 'Foreground', status: 'stopped', createdAt: 0 });
    const updates: ScheduleExecutionUpdate[] = [];
    const result = await executor.execute(run(agentTask('/eco scheduled needle', 'slow-model')), new AbortController().signal, (change) => updates.push(change));
    expect(result).toEqual({ status: 'succeeded' });
    const id = updates.find((change) => change.sessionId)?.sessionId;
    expect(id).toBeDefined();
    if (id === undefined) throw new Error('missing scheduled session');
    expect(updates.map((change) => change.output ?? '').join('')).toBe('scheduled needle');
    expect(findSessionById(db, id)).toMatchObject({ automationRunId: 'run', accountId: null, status: 'stopped' });
    expect(broadcasts.filter((message) => message.type === 'session' && message.session.id === id).every((message) =>
      message.type === 'session' && message.session.automationRunId === 'run')).toBe(true);
    expect(listSessionsByWorkspace(db, 'workspace').map((session) => session.id)).toEqual(['ordinary']);
    expect(listAllSessionsByWorkspace(db, 'workspace')).toHaveLength(2);
    expect(searchSessionMessages(db, { query: 'needle', limit: 20 })).toEqual([]);
    expect(countLiveSessions(db)).toBe(0);
    expect(learned).not.toHaveBeenCalled();
    const sent = await methods(id);
    expect(sent.indexOf('session/set_config_option')).toBeLessThan(sent.indexOf('session/prompt'));
    expect(findSessionConfigOptions(db, id)?.find((option) => option.id === 'model')).toMatchObject({ currentValue: 'slow-model' });
  });

  it('opens a fresh ACP session on the explicitly selected account instead of inheriting the foreground active account', async () => {
    insertAgentProfile(db, { id: 'selected', agent: 'claude', label: 'Synthetic account', createdAt: 1 });
    setActiveAccountId(db, 'claude', 'selected');
    const ids: string[] = [];
    for (const accountId of ['default', 'selected']) {
      const updates: ScheduleExecutionUpdate[] = [];
      const task: ScheduleTask = { kind: 'agent', agentId: 'claude', accountId, model: '', prompt: '/env CLAUDE_CONFIG_DIR' };
      expect(await executor.execute(run(task, `run-${accountId}`), new AbortController().signal, (change) => updates.push(change))).toEqual({ status: 'succeeded' });
      const id = updates.find((change) => change.sessionId)?.sessionId;
      if (id === undefined) throw new Error('missing selected-account session');
      ids.push(id);
      expect(findSessionById(db, id)?.accountId).toBe(accountId === 'default' ? null : 'selected');
      const expected = accountId === 'default' ? join(base, 'principal-claude') : join(base, 'accounts', 'claude', 'selected');
      expect(updates.map((change) => change.output ?? '').join('')).toBe(`CLAUDE_CONFIG_DIR=${expected}`);
    }
    expect(new Set(ids).size).toBe(2);
    expect(listSessionsByWorkspace(db, 'workspace')).toEqual([]);
  });

  it('does not equate prompt submission with turn completion and counts a running automation session as busy', async () => {
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();
    let resolved = false;
    const execution = executor.execute(run(agentTask('slow')), controller.signal, (change) => {
      if (change.output?.includes('Trabalhando')) started.resolve();
    });
    void execution.then(() => { resolved = true; }, () => { resolved = true; });
    await started.promise;
    expect(resolved).toBe(false);
    expect(countLiveSessions(db)).toBe(1);
    expect(countBusySessions(db)).toBe(1);
    expect(listSessionsByWorkspace(db, 'workspace')).toEqual([]);
    controller.abort(new Error('cancel synthetic turn'));
    await expect(execution).rejects.toThrow('cancel synthetic turn');
    expect(countLiveSessions(db)).toBe(0);
  });

  it('waits for explicit permission without YOLO and can be cancelled while waiting', async () => {
    const waiting = Promise.withResolvers<void>();
    const controller = new AbortController();
    let sessionId: string | undefined;
    const execution = executor.execute(run(agentTask('permission-edit')), controller.signal, (change) => {
      if (change.sessionId !== undefined) sessionId = change.sessionId;
      if (change.status === 'awaiting_permission') waiting.resolve();
    });
    await waiting.promise;
    expect(sessionId).toBeDefined();
    expect(findSessionById(db, sessionId ?? '')?.status).toBe('awaiting_permission');
    const events = listEvents(db, sessionId ?? '', 0, 100);
    expect(events.some((event) => event.kind === 'permission_request')).toBe(true);
    expect(events.some((event) => event.kind === 'permission_auto_approved')).toBe(false);
    controller.abort(new Error('cancel permission wait'));
    await expect(execution).rejects.toThrow('cancel permission wait');
    expect(countLiveSessions(db)).toBe(0);
  });

  it('completes after an explicit permission answer through the ordinary approval flow', async () => {
    const waiting = Promise.withResolvers<string>();
    const execution = executor.execute(run(agentTask('permission')), new AbortController().signal, (change) => {
      if (change.status === 'awaiting_permission') {
        const session = listAllSessionsByWorkspace(db, 'workspace')[0];
        if (session !== undefined) waiting.resolve(session.id);
      }
    });
    const id = await waiting.promise;
    const request = listEvents(db, id, 0, 100).find((event) => event.kind === 'permission_request');
    if (request?.kind !== 'permission_request') throw new Error('missing permission');
    sessions.respondPermission(id, request.requestId, 'allow');
    expect(await execution).toEqual({ status: 'succeeded' });
  });

  it('fails an unavailable model before any inference and releases its session process', async () => {
    let id = '';
    const result = await executor.execute(run(agentTask('/eco must not run', 'missing-model')), new AbortController().signal, (change) => { id = change.sessionId ?? id; });
    expect(result.status).toBe('failed');
    expect(await methods(id)).not.toContain('session/prompt');
    expect(countLiveSessions(db)).toBe(0);
  });

  it('observes process failure instead of reporting submission success', async () => {
    const result = await executor.execute(run(agentTask('die')), new AbortController().signal, () => undefined);
    expect(result.status).toBe('failed');
    expect(countLiveSessions(db)).toBe(0);
  });

  it('cancels profile preparation before spawn and does not resurrect the run when preparation later completes', async () => {
    const preparation = Promise.withResolvers<void>();
    const preparing = Promise.withResolvers<void>();
    vi.spyOn(accounts, 'prepare').mockImplementation(() => { preparing.resolve(); return preparation.promise; });
    const controller = new AbortController();
    const execution = executor.execute(run(agentTask('/eco must not run')), controller.signal, () => undefined);
    await preparing.promise;
    controller.abort(new Error('cancel startup'));
    await expect(execution).rejects.toThrow('cancel startup');
    preparation.resolve();
    await Promise.resolve();
    expect(await readdir(join(base, 'pids'))).toEqual([]);
    expect(listAllSessionsByWorkspace(db, 'workspace')[0]).toMatchObject({ status: 'stopped', automationRunId: 'run' });
  });

  // Real OS startup and termination against a platform AbortSignal deadline cannot be driven by fake clocks.
  it('bounds an unresponsive ACP startup by the execution deadline', async () => {
    await expect(executor.execute(run(agentTask('never sent', '', 'stalled')), AbortSignal.timeout(100), () => undefined)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(countLiveSessions(db)).toBe(0);
  });

  it('preserves attachments when cleanup races an already reserved resume', async () => {
    let sessionId = '';
    const execution = run(agentTask('/eco retained attachment'));
    await executor.execute(execution, new AbortController().signal, (change) => { sessionId = change.sessionId ?? sessionId; });
    const directory = join(base, 'files', sessionId);
    await mkdir(directory, { recursive: true });
    const attachment = join(directory, 'retained.txt');
    await writeFile(attachment, 'saved attachment');
    const preparation = Promise.withResolvers<void>();
    const preparing = Promise.withResolvers<void>();
    const prepare = accounts.prepare.bind(accounts);
    vi.spyOn(accounts, 'prepare').mockImplementationOnce((...args) => {
      preparing.resolve();
      return preparation.promise.then(() => prepare(...args));
    });
    const resuming = sessions.resume(sessionId);
    try {
      await preparing.promise;
      await expect(executor.forget({ ...execution, status: 'succeeded', sessionId })).rejects.toMatchObject({ code: 'session_busy' });
      expect(await readFile(attachment, 'utf8')).toBe('saved attachment');
    } finally {
      preparation.resolve();
      await resuming;
    }
  });

  it('blocks a new resume for the entire attachment cleanup operation', async () => {
    insertSession(db, { id: 'cleaning', workspaceId: 'workspace', agent: 'fixture', title: 'Retained execution', status: 'stopped', createdAt: 1, automationRunId: 'run' });
    const directory = join(base, 'files', 'cleaning');
    await mkdir(directory, { recursive: true });
    const attachment = join(directory, 'retained.txt');
    await writeFile(attachment, 'saved attachment');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleaning = sessions.forgetStopped('cleaning', async () => {
      entered.resolve();
      await release.promise;
      await rm(directory, { recursive: true, force: true });
    });
    try {
      await entered.promise;
      await expect(sessions.resume('cleaning')).rejects.toMatchObject({ code: 'session_busy' });
      expect(await readFile(attachment, 'utf8')).toBe('saved attachment');
    } finally {
      release.resolve();
      await cleaning;
    }
    expect(findSessionById(db, 'cleaning')).toBeUndefined();
    expect(existsSync(directory)).toBe(false);
  });

  it('discovers real model config options without prompt, mutation, or persisted session', async () => {
    expect(await executor.models('workspace', 'fixture', 'default', new AbortController().signal)).toEqual({
      supported: true, currentModel: 'fast', models: [{ id: 'fast', name: 'Rápido' }, { id: 'slow-model', name: 'Potente' }],
    });
    expect(listAllSessionsByWorkspace(db, 'workspace')).toEqual([]);
    const files = (await readdir(join(base, 'pids'))).filter((file) => file.endsWith('.methods.jsonl'));
    expect(files).toHaveLength(1);
    const requests = (await readFile(join(base, 'pids', files[0] ?? ''), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string);
    expect(requests).toEqual(['initialize', 'session/new']);
    expect(await executor.models('workspace', 'modes', 'default', new AbortController().signal)).toEqual({ supported: false, currentModel: null, models: [] });
  });

  // Probe cancellation deliberately uses the platform deadline while a real subprocess is connected.
  it('cancels an unresponsive model probe and releases the query claim', async () => {
    await expect(executor.models('workspace', 'stalled', 'default', AbortSignal.timeout(100))).rejects.toBeDefined();
    expect(listAllSessionsByWorkspace(db, 'workspace')).toEqual([]);
    expect(countLiveSessions(db)).toBe(0);
    await expect(executor.models('workspace', 'stalled', 'default', AbortSignal.timeout(100))).rejects.toBeDefined();
  });
});

function invoke(shell: ShellId, script: string): string {
  if (shell === 'cmd') return `"${process.execPath}" "${script}"`;
  const quoted = [process.execPath, script].map((value) => `'${value.replaceAll("'", shell === 'bash' ? "'\\''" : "''")}'`).join(' ');
  return shell === 'bash' ? quoted : `& ${quoted}`;
}

describe.each(localShells())('scheduled real $id command', (shell) => {
  it('captures stdout/stderr with an observable exit code, canonical cwd, and stripped daemon secrets', async () => {
    vi.stubEnv('NANACHI_SCHEDULE_TEST_SECRET', 'must-not-leak');
    const script = join(base, 'command.cjs');
    await writeFile(script, "console.log(JSON.stringify({cwd:process.cwd(),secret:process.env.NANACHI_SCHEDULE_TEST_SECRET??null})); console.error('stderr-line');");
    const updates: ScheduleExecutionUpdate[] = [];
    expect(await executor.execute(run({ kind: 'command', shell: shell.id, command: invoke(shell.id, script) }), new AbortController().signal, (change) => updates.push(change))).toEqual({ status: 'succeeded', exitCode: 0 });
    const output = updates.map((change) => change.output ?? '').join('');
    expect(output).toContain('stderr-line');
    expect(output).toContain('"secret":null');
    expect(output).toContain(JSON.stringify(join(base, 'workspace')));
    expect(output).not.toContain('must-not-leak');
  });

  it('reports a real nonzero exit rather than shell submission success', async () => {
    const script = join(base, 'nonzero.cjs');
    await writeFile(script, 'process.exit(7);');
    expect(await executor.execute(run({ kind: 'command', shell: shell.id, command: invoke(shell.id, script) }), new AbortController().signal, () => undefined)).toMatchObject({ status: 'failed', exitCode: 7 });
  });

  it('preserves quoted spaced/non-ASCII child paths, shell operators, and the final native exit code', async () => {
    const directory = join(base, 'pasta com espaço á');
    await mkdir(directory);
    const script = join(directory, 'filho citado.cjs');
    await writeFile(script, `console.log(JSON.stringify({ text: 'citação "literal"' })); process.exit(7);`);
    const invocation = invoke(shell.id, script);
    const command = `${invocation} ${shell.id === 'cmd' ? '&' : ';'} ${invocation}`;
    const updates: ScheduleExecutionUpdate[] = [];
    expect(await executor.execute(run({ kind: 'command', shell: shell.id, command }), new AbortController().signal, (change) => updates.push(change))).toMatchObject({ status: 'failed', exitCode: 7 });
    const lines = updates.map((change) => change.output ?? '').join('').trim().split(/\r?\n/);
    expect(lines.map((line) => JSON.parse(line) as { text: string })).toEqual([
      { text: 'citação "literal"' }, { text: 'citação "literal"' },
    ]);
  });

  it('cancels the entire child process tree and waits for release', async () => {
    const script = join(base, 'tree.cjs');
    await writeFile(script, "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); console.log(JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000);");
    const controller = new AbortController();
    const running = Promise.withResolvers<{ parent: number; child: number }>();
    let output = '';
    const execution = executor.execute(run({ kind: 'command', shell: shell.id, command: invoke(shell.id, script) }), controller.signal, (change) => {
      output += change.output ?? '';
      const line = output.split(/\r?\n/).find((item) => item.startsWith('{') && item.endsWith('}'));
      if (line !== undefined) running.resolve(JSON.parse(line) as { parent: number; child: number });
    });
    const pids = await running.promise;
    controller.abort(new Error('cancel command tree'));
    await expect(execution).rejects.toThrow('cancel command tree');
    expect(await waitUntilDead(pids.parent)).toBe(true);
    expect(await waitUntilDead(pids.child)).toBe(true);
  });

  it('does not orphan inherited-output descendants when their native launcher exits', async () => {
    const descendant = join(base, 'inherited-output.cjs');
    await writeFile(descendant, 'setInterval(()=>{},1000);');
    const launcher = join(base, 'exiting-launcher.cjs');
    await writeFile(launcher, `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'inherit'}); console.log(JSON.stringify({pid:child.pid})); child.unref(); process.exit(0);`);
    let output = '';
    const result = await executor.execute(run({ kind: 'command', shell: shell.id, command: invoke(shell.id, launcher) }), new AbortController().signal, (change) => { output += change.output ?? ''; });
    expect(result).toEqual({ status: 'succeeded', exitCode: 0 });
    const payload: unknown = JSON.parse(output.trim());
    if (payload === null || typeof payload !== 'object' || !('pid' in payload) || typeof payload.pid !== 'number') throw new Error('missing owned descendant pid');
    expect(await waitUntilDead(payload.pid)).toBe(true);
  });

  it('cancels bootstrap without allowing a late shell launch or command side effect', async () => {
    const marker = join(base, 'must-not-start.txt');
    const script = join(base, 'must-not-start.cjs');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected launch'); setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const execution = executor.execute(run({ kind: 'command', shell: shell.id, command: invoke(shell.id, script) }), controller.signal, () => undefined);
    controller.abort(new Error('cancel bootstrap'));
    await expect(execution).rejects.toThrow('cancel bootstrap');
    expect(existsSync(marker)).toBe(false);
  });

  // The shell/process tree is real; the platform AbortSignal deadline itself is the behavior under test.
  it('honors the deadline even for a command that never exits', async () => {
    const script = join(base, 'deadline.cjs');
    await writeFile(script, 'setInterval(()=>{},1000);');
    await expect(executor.execute(run({ kind: 'command', shell: shell.id, command: invoke(shell.id, script) }), AbortSignal.timeout(100), () => undefined)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('schedule validation', () => {
  it('rejects disabled commands, unknown agents/accounts, and out-of-roots workspaces without starting a process', () => {
    config.shellSessions = false;
    expect(() => executor.validate('workspace', { kind: 'command', shell: 'cmd', command: 'exit 0' })).toThrow('desligados');
    expect(() => executor.validate('workspace', agentTask('x', '', 'absent'))).toThrow('desconhecido');
    expect(() => executor.validate('workspace', { kind: 'agent', agentId: 'fixture', accountId: 'absent', model: '', prompt: 'x' })).toThrow();
    config.allowedRoots = [];
    expect(() => executor.validate('workspace', agentTask('x'))).toThrow();
    expect(listAllSessionsByWorkspace(db, 'workspace')).toEqual([]);
  });

  it('ordinary search still finds foreground messages when automation is present', () => {
    for (const [id, automationRunId] of [['ordinary', undefined], ['automated', 'run']] as const) {
      insertSession(db, { id, workspaceId: 'workspace', agent: 'fixture', title: id, status: 'stopped', createdAt: 1, ...(automationRunId === undefined ? {} : { automationRunId }) });
      insertEvent(db, { sessionId: id, kind: 'user_message', ts: 1, payload: JSON.stringify({ text: 'shared needle' }) });
    }
    expect(searchSessionMessages(db, { query: 'needle', limit: 20 }).map((hit) => hit.sessionId)).toEqual(['ordinary']);
  });

  it('counts command ownership through terminal cleanup and avoids double-counting scheduled agent sessions', () => {
    const repository = new ScheduleRepository(db);
    const command = run({ kind: 'command', shell: 'cmd', command: 'exit 0' });
    repository.insertRun(command);
    expect(countBusySessions(db)).toBe(1);
    expect(hasBusySessionsInWorkspace(db, 'workspace')).toBe(true);
    expect(hasBusySessionsInWorkspace(db, 'other')).toBe(false);
    repository.updateActiveRun({ ...command, status: 'cancelled', finishedAt: 2 });
    expect(countBusySessions(db)).toBe(1);
    repository.releaseRun(command);
    expect(countBusySessions(db)).toBe(0);
    const agent = { ...run(agentTask('x'), 'agent-run'), scheduleId: 'agent-schedule' };
    repository.insertRun(agent);
    insertSession(db, { id: 'agent-session', workspaceId: 'workspace', agent: 'fixture', title: 'Scheduled', status: 'running', createdAt: 1, automationRunId: agent.id });
    expect(countBusySessions(db)).toBe(1);
  });

  it('forgets only owned terminal automation history and files, retaining retry ownership on cleanup failure', async () => {
    const execution: ScheduleRun = { ...run(agentTask('x')), status: 'succeeded', finishedAt: 2 };
    insertSession(db, { id: 'owned', workspaceId: 'workspace', agent: 'fixture', title: 'Scheduled', status: 'stopped', createdAt: 1, automationRunId: execution.id });
    insertSession(db, { id: 'ordinary', workspaceId: 'workspace', agent: 'fixture', title: 'Foreground', status: 'stopped', createdAt: 1 });
    insertEvent(db, { sessionId: 'owned', kind: 'user_message', ts: 1, payload: JSON.stringify({ text: 'owned history' }) });
    await mkdir(join(base, 'files', 'owned'), { recursive: true });
    await writeFile(join(base, 'files', 'owned', 'output.txt'), 'owned attachment');
    await expect(executor.forget({ ...execution, sessionId: 'ordinary' })).rejects.toThrow('não pertence');
    expect(findSessionById(db, 'ordinary')).toBeDefined();
    db.exec("CREATE TRIGGER fail_owned_cleanup BEFORE DELETE ON sessions WHEN OLD.id = 'owned' BEGIN SELECT RAISE(ABORT, 'synthetic persistence interruption'); END;");
    await expect(executor.forget({ ...execution, sessionId: 'owned' })).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(findSessionById(db, 'owned')?.automationRunId).toBe(execution.id);
    db.exec('DROP TRIGGER fail_owned_cleanup');
    await executor.forget({ ...execution, sessionId: 'owned' });
    expect(findSessionById(db, 'owned')).toBeUndefined();
    expect(listEvents(db, 'owned', 0, 100)).toEqual([]);
    expect(existsSync(join(base, 'files', 'owned'))).toBe(false);
    expect(findSessionById(db, 'ordinary')).toBeDefined();
  });

  it('does not prune a completed run whose dedicated conversation was resumed by the user', async () => {
    const execution: ScheduleRun = { ...run(agentTask('x')), status: 'succeeded', finishedAt: 2, sessionId: 'reopened' };
    insertSession(db, { id: 'reopened', workspaceId: 'workspace', agent: 'fixture', title: 'Reopened execution', status: 'idle', createdAt: 1, automationRunId: execution.id });
    await mkdir(join(base, 'files', 'reopened'), { recursive: true });
    await writeFile(join(base, 'files', 'reopened', 'kept.txt'), 'must remain');
    await expect(executor.forget(execution)).rejects.toMatchObject({ code: 'session_busy' });
    expect(findSessionById(db, 'reopened')?.status).toBe('idle');
    expect(await readFile(join(base, 'files', 'reopened', 'kept.txt'), 'utf8')).toBe('must remain');
  });
});
