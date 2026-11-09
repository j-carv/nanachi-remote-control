import { describe, expect, it } from 'vitest';
import { ScheduleInputSchema, ScheduleRunSchema, SCHEDULE_OUTPUT_MAX } from '../src/schedules.js';

const command = {
  name: 'Check tests', cronExpression: '0 9 * * 1-5', timeZone: 'America/Sao_Paulo',
  task: { kind: 'command', shell: 'powershell', command: 'npm test' },
};

describe('workspace schedule requests', () => {
  it('does not enable unattended command execution by default', () => {
    const input = ScheduleInputSchema.parse(command);
    expect(input.enabled).toBe(false);
    expect(input.task).toEqual(command.task);
  });

  it('keeps agent instructions separate from executable shell commands', () => {
    const agent = { name: 'Review', cronExpression: '0 9 * * *', timeZone: 'UTC', task: { kind: 'agent', agentId: 'configured-agent', prompt: 'Review changes without modifying files.' } };
    expect(ScheduleInputSchema.parse(agent).task).toEqual({ ...agent.task, accountId: 'default', model: '' });
    expect(ScheduleInputSchema.safeParse({ ...agent, task: { ...agent.task, command: 'unapproved command' } }).success).toBe(false);
    expect(ScheduleInputSchema.safeParse({ ...command, task: { ...command.task, prompt: 'instructions' } }).success).toBe(false);
  });

  it('rejects arbitrary environment and approval overrides', () => {
    expect(ScheduleInputSchema.safeParse({ ...command, env: { NANACHI_AGENT_TOKEN: 'not-a-real-token' } }).success).toBe(false);
    expect(ScheduleInputSchema.safeParse({ ...command, task: { ...command.task, yolo: true } }).success).toBe(false);
  });

  it('bounds execution time and rejects empty or oversized task instructions', () => {
    expect(ScheduleInputSchema.safeParse({ ...command, timeoutMs: 999 }).success).toBe(false);
    expect(ScheduleInputSchema.safeParse({ ...command, timeoutMs: 86_400_001 }).success).toBe(false);
    expect(ScheduleInputSchema.safeParse({ ...command, task: { ...command.task, command: '   ' } }).success).toBe(false);
    expect(ScheduleInputSchema.safeParse({ ...command, task: { ...command.task, command: 'x'.repeat(10_001) } }).success).toBe(false);
  });

  it('retains a bounded run snapshot rather than accepting unbounded process output', () => {
    const run = {
      id: 'run-1', scheduleId: 'schedule-1', workspaceId: 'workspace-1', scheduleName: 'Check tests', task: command.task,
      trigger: 'manual', status: 'failed', scheduledAt: 1000, startedAt: 1000, finishedAt: 2000,
      sessionId: null, exitCode: 3, error: 'Command exited with code 3', output: 'A test failed', outputTruncated: false,
    };
    expect(ScheduleRunSchema.parse(run).exitCode).toBe(3);
    expect(ScheduleRunSchema.safeParse({ ...run, output: 'x'.repeat(SCHEDULE_OUTPUT_MAX + 1) }).success).toBe(false);
    expect(ScheduleRunSchema.safeParse({ ...run, status: 'pretend_success' }).success).toBe(false);
  });
});
