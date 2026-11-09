import { spawn } from 'node:child_process';
import type { ScheduleRun, ScheduleTask, ShellId } from '@nanachi/shared';
import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';
import type { LoadedConfig } from './config.js';
import { removeSessionFiles } from './files.js';
import { findSessionById, findWorkspaceById } from './repository.js';
import { PathError, resolveInsideRoots } from './roots.js';
import type { ScheduleExecutionResult, ScheduleExecutionUpdate, ScheduleExecutor } from './schedule-execution.js';
import { windowsJobCommand } from './schedule-command-windows.js';
import { SessionError, type SessionManager } from './session-manager.js';
import { chooseShell, localShells, shellEnvironment } from './shells.js';

interface ScheduleExecutorOptions {
  db: Database.Database;
  sessions: SessionManager;
  config: LoadedConfig;
  log: FastifyBaseLogger;
  filesRoot: string;
}

const KILL_TIMEOUT_MS = 5_000;

function commandArguments(shell: ShellId, command: string): string[] {
  switch (shell) {
    case 'pwsh':
    case 'powershell':
      return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}\n$__nanachiSucceeded = $?; if ($__nanachiSucceeded) { exit 0 }; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1`];
    case 'cmd': return ['/d', '/s', '/c', `"chcp 65001>nul & ${command}"`];
    case 'bash': return ['--noprofile', '--norc', '-c', command];
  }
}

/** Runs owner-authored programs, never a PTY or a foreground conversation. */
export function createScheduleExecutor({ db, sessions, config, log, filesRoot }: ScheduleExecutorOptions): ScheduleExecutor {
  function workspacePath(workspaceId: string): string {
    const workspace = findWorkspaceById(db, workspaceId);
    if (workspace === undefined) throw new SessionError('not_found', 'workspace não encontrado');
    try {
      return resolveInsideRoots(workspace.path, config.allowedRoots);
    } catch (error) {
      if (error instanceof PathError) throw new SessionError(error.code === 'outside_roots' ? 'outside_roots' : 'invalid_request', error.message);
      throw error;
    }
  }

  function commandShell(task: Extract<ScheduleTask, { kind: 'command' }>) {
    if (!config.shellSessions) throw new SessionError('shell_disabled', 'comandos de workspace desligados');
    const shell = chooseShell(localShells(), task.shell);
    if (shell === undefined) throw new SessionError('shell_unavailable', 'shell selecionado indisponível neste PC');
    return shell;
  }

  async function command(run: ScheduleRun, signal: AbortSignal, update: (change: ScheduleExecutionUpdate) => void): Promise<ScheduleExecutionResult> {
    if (run.task.kind !== 'command') throw new SessionError('invalid_request', 'agendamento não é de comando');
    signal.throwIfAborted();
    const cwd = workspacePath(run.workspaceId);
    const shell = commandShell(run.task);
    signal.throwIfAborted();
    const args = commandArguments(shell.id, run.task.command);
    const launch: { file: string; args: string[]; input?: string } = process.platform === 'win32'
      ? windowsJobCommand(shell.file, args, cwd, shell.id === 'cmd')
      : { file: shell.file, args };
    const child = spawn(launch.file, launch.args, {
      cwd,
      env: shellEnvironment(process.env),
      windowsHide: true,
      windowsVerbatimArguments: false,
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(launch.input);
    const ended = Promise.withResolvers<ScheduleExecutionResult>();
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let streamError: string | undefined;
    const finish = (result: ScheduleExecutionResult): void => {
      if (settled) return;
      settled = true;
      ended.resolve(result);
    };
    const output = (text: string): void => {
      if (!settled && !signal.aborted) update({ output: text });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.stdout.on('error', () => { streamError = 'Falha ao ler saída do comando.'; abort(); });
    child.stderr.on('error', () => { streamError = 'Falha ao ler saída do comando.'; abort(); });
    child.once('error', () => finish({ status: 'failed', error: 'Não foi possível iniciar o shell selecionado.' }));
    child.once('close', (code, exitSignal) => finish(streamError !== undefined
      ? { status: 'failed', exitCode: code, error: streamError }
      : code === 0
        ? { status: 'succeeded', exitCode: 0 }
        : { status: 'failed', exitCode: code, error: code === null ? `Comando encerrado por sinal ${exitSignal ?? 'desconhecido'}.` : `Comando terminou com código ${code}.` }));
    const abort = (): void => {
      if (killTimer !== undefined || settled) return;
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          // Closing the wrapper's sole Job Object handle terminates the atomically-owned tree.
          child.kill('SIGKILL');
        }
        else {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        }
      }
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ status: 'failed', error: 'O comando não confirmou o encerramento após cancelamento.' });
      }, KILL_TIMEOUT_MS);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const result = await ended.promise;
      signal.throwIfAborted();
      return result;
    } finally {
      clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      child.stdout.off('data', output);
      child.stderr.off('data', output);
      if (child.exitCode === null && child.signalCode === null) {
        // A stream/spawn failure must not leave the command tree running either.
        abort();
        clearTimeout(killTimer);
      }
    }
  }

  async function agent(run: ScheduleRun, signal: AbortSignal, update: (change: ScheduleExecutionUpdate) => void): Promise<ScheduleExecutionResult> {
    if (run.task.kind !== 'agent') throw new SessionError('invalid_request', 'agendamento não é de agente');
    const completed = Promise.withResolvers<ScheduleExecutionResult>();
    let sessionId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    let prompted = false;
    const finish = (result: ScheduleExecutionResult): void => {
      if (settled) return;
      settled = true;
      completed.resolve(result);
    };
    const abort = (): void => {
      finish({ status: 'failed', error: 'Execução cancelada.' });
      if (sessionId !== undefined) void sessions.stopScheduled(sessionId).catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await sessions.createScheduled(run, signal, (id) => {
        sessionId = id;
        unsubscribe = sessions.subscribe(id, {
          event: (event) => {
            if (settled || signal.aborted) return;
            switch (event.kind) {
              case 'agent_message_chunk': update({ output: event.text }); break;
              case 'permission_request': update({ status: 'awaiting_permission' }); break;
              case 'permission_resolved': update({ status: 'running' }); break;
              case 'error': finish({ status: 'failed', error: event.message }); break;
              case 'status':
                if (event.status === 'stopped' || event.status === 'error') finish({ status: 'failed', error: 'Agente encerrado antes de completar o turno.' });
                break;
              case 'turn_end':
                if (prompted) finish(event.stopReason === 'end_turn'
                  ? { status: 'succeeded' }
                  : { status: 'failed', error: `Turno encerrado: ${event.stopReason}.` });
                break;
            }
          },
          commands: () => undefined,
          configOptions: () => undefined,
          promptQueue: () => undefined,
          loop: () => undefined,
        });
        update({ sessionId: id });
      });
      signal.throwIfAborted();
      if (!settled && sessionId !== undefined) {
        prompted = true;
        // Submission is not completion; the subscription above owns the actual ACP turn outcome.
        await sessions.prompt(sessionId, run.task.prompt);
      }
      const result = await completed.promise;
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SessionError) return { status: 'failed', error: error.message };
      log.warn({ runId: run.id }, 'scheduled agent execution failed');
      return { status: 'failed', error: 'Não foi possível executar o agente agendado.' };
    } finally {
      signal.removeEventListener('abort', abort);
      unsubscribe?.();
      if (sessionId !== undefined) await sessions.stopScheduled(sessionId);
    }
  }

  return {
    validate(workspaceId, task) {
      workspacePath(workspaceId);
      if (task.kind === 'agent') sessions.validateScheduledAgent(workspaceId, task.agentId, task.accountId);
      else commandShell(task);
    },
    execute(run, signal, update) {
      return run.task.kind === 'command' ? command(run, signal, update) : agent(run, signal, update);
    },
    models(workspaceId, agentId, accountId, signal) {
      return sessions.scheduleModels(workspaceId, agentId, accountId, signal);
    },
    async forget(run) {
      if (run.task.kind !== 'agent') return;
      if (run.status === 'running' || run.status === 'awaiting_permission') throw new SessionError('busy', 'execução ainda está ativa');
      const owned = run.sessionId === null
        ? db.prepare<[string, string], { id: string }>('SELECT id FROM sessions WHERE automation_run_id = ? AND workspace_id = ?').get(run.id, run.workspaceId)?.id
        : run.sessionId;
      if (owned === undefined) return;
      const session = findSessionById(db, owned);
      if (session === undefined) return;
      if (session.automationRunId !== run.id || session.workspaceId !== run.workspaceId) {
        throw new SessionError('invalid_request', 'sessão não pertence a esta execução');
      }
      await sessions.forgetStopped(owned, async () => {
        let failed = false;
        await removeSessionFiles(filesRoot, [owned], () => { failed = true; });
        if (failed) {
          log.warn({ runId: run.id }, 'scheduled session files could not be removed');
          throw new Error('scheduled session cleanup failed');
        }
      });
    },
  };
}
