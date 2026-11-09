import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ScheduleSchema, ScheduleRunSchema, type Schedule, type ScheduleRun } from '@nanachi/shared';
import { ApiError, type ApiClient } from '../api.js';
import { setLanguage } from '../i18n/index.js';
import { ScheduleRows } from '../screens/SchedulesScreen.js';
import { ScheduleForm, ScheduleModelPicker, presetCron, scheduleInput } from './ScheduleForm.js';
import { ScheduleRunDetails } from './ScheduleHistory.js';

const noop = () => undefined;
const schedule: Schedule = ScheduleSchema.parse({
  id: 'sched-1', workspaceId: 'workspace-1', name: 'Daily report', enabled: false,
  cronExpression: '30 9 * * 1-5', timeZone: 'America/Sao_Paulo', timeoutMs: 600000,
  nextRunAt: null, createdAt: 1, updatedAt: 1,
  task: { kind: 'agent', agentId: 'fake-acp', accountId: 'work', model: 'selected-model', prompt: 'Review the repository' },
});
const formProps = {
  api: {} as ApiClient, workspaceId: schedule.workspaceId,
  agents: [{ id: 'fake-acp', label: 'Synthetic agent', kind: 'acp' as const }, { id: 'terminal', label: 'Not an ACP agent', kind: 'pty' as const }],
  accounts: [{ agentId: 'fake-acp', label: 'Synthetic agent', status: 'unknown' as const, account: null, detail: null, checkedAt: 1, supportsAccounts: true, profiles: [
    { id: 'default', label: 'Principal', isDefault: true, active: true, status: 'unknown' as const, account: null, detail: null, checkedAt: 1 },
    { id: 'work', label: 'Work account', isDefault: false, active: false, status: 'logged_in' as const, account: 'work@example.test', detail: null, checkedAt: 1 },
  ] }],
  shells: [{ id: 'powershell' as const, label: 'PowerShell', isDefault: true }, { id: 'cmd' as const, label: 'Command Prompt', isDefault: false }],
  onSaved: noop, onCancel: noop,
};
function form(value: Schedule | null) { return renderToStaticMarkup(createElement(ScheduleForm, { ...formProps, schedule: value })); }
function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return ScheduleRunSchema.parse({ id: 'run-1', scheduleId: schedule.id, workspaceId: schedule.workspaceId,
    scheduleName: schedule.name, task: schedule.task, trigger: 'manual', status: 'running', scheduledAt: 1000,
    startedAt: 1001, finishedAt: null, sessionId: 'automation-session', exitCode: null, error: null,
    output: 'Tool output <script>alert(1)</script>', outputTruncated: false, ...overrides });
}
function details(value: ScheduleRun) {
  return renderToStaticMarkup(createElement(ScheduleRunDetails, { run: value, busy: false, onCancel: noop, onOpen: noop }));
}
afterEach(() => setLanguage('pt-BR'));

describe('workspace schedule forms', () => {
  it('starts paused, asks for an explicit agent, and discloses same-user rights and permission approval', () => {
    setLanguage('en');
    const markup = form(null);
    const enabled = markup.match(/<input[^>]*data-slot="schedule-enabled"[^>]*>/)?.[0];
    expect(enabled).toBeDefined();
    expect(enabled).not.toContain('checked');
    expect(markup).toContain('value="default" selected');
    expect(markup).toContain('Choose an agent');
    expect(markup).not.toContain('Not an ACP agent');
    expect(markup).toContain('same rights as its signed-in user');
    expect(markup).toContain('not a sandbox');
    expect(markup).toContain('never automatically granted');
    expect(markup).toContain('Deadline (seconds, 1–86400)');
    expect(markup).toContain('value="600"');
    expect(markup).toContain('Preview next 5 executions');
  });

  it('preserves the chosen agent, explicit account and exact model ID on edit', () => {
    const markup = form(schedule);
    expect(markup).toContain('value="fake-acp" selected');
    expect(markup).toContain('value="work" selected');
    expect(markup).toContain('Work account · work@example.test');
    expect(markup).toContain('value="selected-model"');
    expect(markup).toContain('Review the repository');
    expect(markup).toContain('value="30 9 * * 1-5"');
    expect(markup).toContain('value="America/Sao_Paulo"');
    expect(markup).not.toContain('data-slot="schedule-command"');
    expect(scheduleInput(schedule)).toEqual({ name: schedule.name, cronExpression: schedule.cronExpression,
      timeZone: schedule.timeZone, timeoutMs: 600000, enabled: false, task: schedule.task });
  });

  it('renders actual command/shell values without agent controls or hidden permission configuration', () => {
    setLanguage('en');
    const markup = form({ ...schedule, task: { kind: 'command', shell: 'cmd', command: 'echo workspace report' } });
    expect(markup).toContain('value="command" selected');
    expect(markup).toContain('value="cmd" selected');
    expect(markup).toContain('echo workspace report');
    expect(markup).not.toContain('data-slot="schedule-agent"');
    expect(markup).not.toContain('data-slot="schedule-model-id"');
    expect(markup).toContain('Cancelling cannot undo external effects');
    expect(markup).not.toContain('name="env"');
  });

  it.each([
    ['hourly', '09:30', '1', '0 * * * *'],
    ['daily', '09:30', '1', '30 9 * * *'],
    ['weekdays', '00:05', '1', '5 0 * * 1-5'],
    ['weekly', '18:45', '0', '45 18 * * 0'],
  ] as const)('turns the %s preset into five actual cron fields', (preset, time, day, expected) => {
    expect(presetCron(preset, time, day)).toBe(expected);
  });

  it('does not invent a midnight execution when the required time is erased or invalid', () => {
    expect(presetCron('daily', '', '1')).toBe('');
    expect(presetCron('weekly', '25:70', '1')).toBe('');
  });
});

describe('agent model discovery', () => {
  const props = { model: 'manual/model', catalog: null, loading: false, error: null, canDiscover: true, onChange: noop, onDiscover: noop };
  it('keeps exact manual IDs available when discovery is unsupported or fails', () => {
    setLanguage('en');
    const markup = renderToStaticMarkup(createElement(ScheduleModelPicker, { ...props, catalog: { models: [], currentModel: null, supported: false }, error: new ApiError('network') }));
    expect(markup).toContain('value="manual/model"');
    expect(markup).toContain('does not provide a model catalog');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Discover models');
    expect(markup).not.toContain('data-slot="schedule-model-catalog"');
  });
  it('shows real catalog names, retains manual input and disables duplicate discovery', () => {
    const markup = renderToStaticMarkup(createElement(ScheduleModelPicker, { ...props, model: 'discovered/id', loading: true, catalog: { supported: true, currentModel: 'discovered/id', models: [{ id: 'discovered/id', name: 'Discovered model' }] } }));
    expect(markup).toContain('value="discovered/id" selected');
    expect(markup).toContain('Discovered model');
    expect(markup).toContain('data-slot="schedule-model-id"');
    expect(markup).toMatch(/<button(?=[^>]*data-slot="schedule-refresh-models")(?=[^>]*disabled)(?=[^>]*aria-busy="true")/);
  });
});

describe('dedicated run history and controls', () => {
  it('offers explicit Open execution for agent approval, never for direct commands', () => {
    setLanguage('en');
    const markup = details(run({ status: 'awaiting_permission' }));
    expect(markup).toContain('Open execution');
    expect(markup).toContain('existing approval screen');
    expect(markup).toContain('Cancel execution');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
    expect(details(run({ task: { kind: 'command', shell: 'powershell', command: 'Write-Output report' }, sessionId: null }))).not.toContain('data-slot="schedule-open-execution"');
  });
  it('shows durable failures, exit codes and truncation without a cancellation action for terminal runs', () => {
    setLanguage('en');
    const markup = details(run({ status: 'failed', finishedAt: 2000, exitCode: 7, error: 'Command returned 7', outputTruncated: true }));
    expect(markup).toContain('Command returned 7');
    expect(markup).toContain('Exit code: 7');
    expect(markup).toContain('last 65,536 characters');
    expect(markup).not.toContain('data-slot="schedule-cancel-run"');
  });
  it('renders enabled state only from confirmed schedule values and retains manual run while paused', () => {
    setLanguage('en');
    const markup = renderToStaticMarkup(createElement(ScheduleRows, { schedules: [schedule], busy: false, onEdit: noop, onHistory: noop, onAction: noop }));
    expect(markup).toContain('Agent task · Paused');
    expect(markup).toContain('No automatic execution while paused');
    expect(markup).toContain('America/Sao_Paulo');
    expect(markup).toContain('Run now');
    expect(markup).toContain('Run history');
  });
});
