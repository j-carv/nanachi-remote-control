import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentAccount, AgentsResponse, Schedule, ScheduleInput, ScheduleModelsResponse, ShellId, ShellsResponse } from '@nanachi/shared';
import { ScheduleInputSchema } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup } from '../components/ListGroup.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScheduleConfirm } from './ScheduleConfirm.js';

export type TimingPreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
export function presetCron(preset: Exclude<TimingPreset, 'custom'>, time: string, weekday: string): string {
  if (preset === 'hourly') return '0 * * * *';
  if (!/^\d{2}:\d{2}$/.test(time)) return '';
  const [hour = NaN, minute = NaN] = time.split(':').map(Number);
  if (hour > 23 || minute > 59) return '';
  if (preset === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (preset === 'weekly') return `${minute} ${hour} * * ${weekday}`;
  return `${minute} ${hour} * * *`;
}
export function scheduleInput(schedule: Schedule): ScheduleInput {
  return { name: schedule.name, cronExpression: schedule.cronExpression, timeZone: schedule.timeZone,
    enabled: schedule.enabled, timeoutMs: schedule.timeoutMs, task: schedule.task };
}
export const selectClass = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const textareaClass = `${selectClass} py-3`;
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-2 px-4 py-3"><span className="text-sm font-medium">{label}</span>{children}</label>;
}
export function formatScheduleDate(value: number, timeZone: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(value);
}

export function ScheduleModelPicker({ model, catalog, loading, error, canDiscover, onChange, onDiscover }: {
  model: string; catalog: ScheduleModelsResponse | null; loading: boolean; error: unknown; canDiscover: boolean;
  onChange(value: string): void; onDiscover(): void;
}) {
  const { t } = useTranslation('schedules');
  return <li className="flex flex-col gap-2 py-3">
    <Field label={t('model')}>
      <Input data-slot="schedule-model-id" maxLength={500} value={model} onChange={(event) => onChange(event.target.value)} placeholder={t('agentDefault')} />
    </Field>
    {catalog !== null && catalog.models.length > 0 && <div className="px-4">
      <select className={selectClass} aria-label={t('catalog')} data-slot="schedule-model-catalog" value={catalog.models.some((item) => item.id === model) ? model : ''} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('chooseModel')}</option>
        {catalog.models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </div>}
    <div className="flex flex-col gap-2 px-4">
      <p className="text-sm text-muted-foreground">{t('manualModelHint')}</p>
      {catalog?.supported === false && <p role="status" className="text-sm text-muted-foreground">{t('catalogUnsupported')}</p>}
      {catalog?.supported && catalog.models.length === 0 && <p role="status" className="text-sm text-muted-foreground">{t('catalogEmpty')}</p>}
      <ErrorNotice error={error} />
      <Button data-slot="schedule-refresh-models" variant="secondary" type="button" aria-busy={loading} disabled={!canDiscover || loading} onClick={onDiscover}>{loading ? t('loading') : t('refreshModels')}</Button>
    </div>
  </li>;
}

export interface ScheduleFormProps {
  api: ApiClient;
  workspaceId: string;
  schedule: Schedule | null;
  agents: AgentsResponse['agents'];
  accounts: AgentAccount[];
  shells: ShellsResponse['shells'];
  shellsLoading?: boolean;
  onSaved(schedule: Schedule): void;
  onCancel(): void;
}
export function ScheduleForm({ api, workspaceId, schedule, agents, accounts, shells, shellsLoading = false, onSaved, onCancel }: ScheduleFormProps) {
  const { t, i18n } = useTranslation('schedules');
  const [name, setName] = useState(schedule?.name ?? '');
  const [kind, setKind] = useState<'agent' | 'command'>(schedule?.task.kind ?? 'agent');
  const [agentId, setAgentId] = useState(schedule?.task.kind === 'agent' ? schedule.task.agentId : '');
  const [accountId, setAccountId] = useState(schedule?.task.kind === 'agent' ? schedule.task.accountId : 'default');
  const [model, setModel] = useState(schedule?.task.kind === 'agent' ? schedule.task.model : '');
  const [prompt, setPrompt] = useState(schedule?.task.kind === 'agent' ? schedule.task.prompt : '');
  const [shell, setShell] = useState<ShellId | ''>(schedule?.task.kind === 'command' ? schedule.task.shell : shells.find((item) => item.isDefault)?.id ?? shells[0]?.id ?? '');
  const [command, setCommand] = useState(schedule?.task.kind === 'command' ? schedule.task.command : '');
  const [preset, setPreset] = useState<TimingPreset>(schedule ? 'custom' : 'daily');
  const [time, setTime] = useState('09:00');
  const [weekday, setWeekday] = useState('1');
  const [cron, setCron] = useState(schedule?.cronExpression ?? '0 9 * * *');
  const [timeZone, setTimeZone] = useState(schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);
  const [timeout, setTimeoutValue] = useState(String((schedule?.timeoutMs ?? 600_000) / 1000));
  const [catalog, setCatalog] = useState<ScheduleModelsResponse | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{ cron: string; zone: string; times: number[] } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<ScheduleInput | null>(null);
  const active = useRef(true);
  const discovery = useRef(0);
  const previewRequest = useRef(0);
  const warningId = useId();
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [api, workspaceId]);
  useEffect(() => {
    const first = shells.find((item) => item.isDefault) ?? shells[0];
    if (schedule === null && first !== undefined && shell === '') setShell(first.id);
  }, [schedule, shells, shell]);
  const cronExpression = preset === 'custom' ? cron : presetCron(preset, time, weekday);
  const acpAgents = agents.filter((agent) => agent.kind === 'acp');
  const profiles = accounts.find((account) => account.agentId === agentId)?.profiles ?? [];
  const currentPreview = preview?.cron === cronExpression && preview.zone === timeZone ? preview.times : null;

  function changeAgent(value: string) {
    discovery.current++;
    setModelsLoading(false); setModelsError(null); setCatalog(null); setModel(''); setAgentId(value); setAccountId('default');
  }
  function changeAccount(value: string) {
    discovery.current++;
    setModelsLoading(false); setModelsError(null); setCatalog(null); setModel(''); setAccountId(value);
  }
  async function discover() {
    const request = ++discovery.current;
    setModelsLoading(true); setModelsError(null);
    try {
      const result = await api.scheduleModels(workspaceId, agentId, accountId);
      if (active.current && request === discovery.current) setCatalog(result);
    } catch (caught) { if (active.current && request === discovery.current) setModelsError(caught); }
    finally { if (active.current && request === discovery.current) setModelsLoading(false); }
  }
  async function loadPreview() {
    const request = ++previewRequest.current;
    setPreviewLoading(true); setPreviewError(null);
    try {
      const times = await api.previewSchedule(workspaceId, { cronExpression, timeZone });
      if (active.current && request === previewRequest.current) setPreview({ cron: cronExpression, zone: timeZone, times });
    } catch (caught) { if (active.current && request === previewRequest.current) setPreviewError(caught); }
    finally { if (active.current && request === previewRequest.current) setPreviewLoading(false); }
  }
  function review() {
    const result = ScheduleInputSchema.safeParse({ name, cronExpression, timeZone, enabled, timeoutMs: Number(timeout) * 1000,
      task: kind === 'agent' ? { kind, agentId, accountId, model, prompt } : { kind, shell, command } });
    setInvalid(!result.success);
    if (result.success) { setError(null); setConfirmation(result.data); }
  }
  async function save() {
    if (confirmation === null || busy || !active.current) return;
    setBusy(true); setError(null);
    try {
      const saved = schedule === null ? await api.createSchedule(workspaceId, confirmation)
        : await api.updateSchedule(workspaceId, schedule.id, confirmation);
      if (active.current) onSaved(saved);
    } catch (caught) { if (active.current) setError(caught); }
    finally { if (active.current) setBusy(false); }
  }
  return <form data-slot="schedule-form" className="flex min-w-0 flex-col gap-5" onSubmit={(event) => { event.preventDefault(); review(); }}>
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-5">
      <ListGroup label={t('details')}>
        <li><Field label={t('name')}><Input data-slot="schedule-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} autoComplete="off" /></Field></li>
        <li><Field label={t('kind')}><select data-slot="schedule-kind" className={selectClass} value={kind} onChange={(event) => setKind(event.target.value as 'agent' | 'command')}><option value="agent">{t('agentTask')}</option><option value="command">{t('commandTask')}</option></select></Field></li>
      </ListGroup>
      {kind === 'agent' ? <ListGroup label={t('agentTask')}>
        <li><Field label={t('agent')}><select data-slot="schedule-agent" className={selectClass} required value={agentId} onChange={(event) => changeAgent(event.target.value)}><option value="">{t('chooseAgent')}</option>{agentId && !acpAgents.some((agent) => agent.id === agentId) && <option value={agentId}>{agentId}</option>}{acpAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select></Field></li>
        <li><Field label={t('account')}><select data-slot="schedule-account" className={selectClass} value={accountId} onChange={(event) => changeAccount(event.target.value)}><option value="default">{profiles.find((profile) => profile.id === 'default')?.label ?? t('defaultAccount')}</option>{accountId !== 'default' && !profiles.some((profile) => profile.id === accountId) && <option value={accountId}>{accountId}</option>}{profiles.filter((profile) => profile.id !== 'default').map((profile) => <option key={profile.id} value={profile.id}>{profile.label}{profile.account ? ` · ${profile.account}` : ''}</option>)}</select></Field></li>
        <ScheduleModelPicker model={model} catalog={catalog} loading={modelsLoading} error={modelsError} canDiscover={agentId.length > 0} onChange={setModel} onDiscover={() => void discover()} />
        <li><Field label={t('prompt')}><textarea data-slot="schedule-prompt" className={textareaClass} value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} required maxLength={100000} /></Field></li>
      </ListGroup> : <ListGroup label={t('commandTask')}>
        <li><Field label={t('shell')}><select data-slot="schedule-shell" className={selectClass} value={shell} required disabled={shellsLoading} onChange={(event) => setShell(event.target.value as ShellId | '')}><option value="">{t('chooseShell')}</option>{shell && !shells.some((item) => item.id === shell) && <option value={shell}>{shell}</option>}{shells.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>{!shellsLoading && shells.length === 0 && <p className="text-sm text-muted-foreground">{t('noShells')}</p>}</Field></li>
        <li><Field label={t('command')}><textarea data-slot="schedule-command" className={`${textareaClass} font-mono`} value={command} onChange={(event) => setCommand(event.target.value)} rows={6} required maxLength={10000} spellCheck={false} aria-describedby={warningId} /></Field></li>
      </ListGroup>}
      <ListGroup label={t('timing')}>
        <li><Field label={t('frequency')}><select data-slot="schedule-preset" className={selectClass} value={preset} onChange={(event) => setPreset(event.target.value as TimingPreset)}>{(['hourly', 'daily', 'weekdays', 'weekly', 'custom'] as const).map((value) => <option key={value} value={value}>{t(`presets.${value}`)}</option>)}</select></Field></li>
        {preset !== 'custom' && preset !== 'hourly' && <li><Field label={t('time')}><Input type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></Field></li>}
        {preset === 'weekly' && <li><Field label={t('weekday')}><select className={selectClass} value={weekday} onChange={(event) => setWeekday(event.target.value)}>{(['0', '1', '2', '3', '4', '5', '6'] as const).map((day) => <option value={day} key={day}>{t(`weekdays.${day}`)}</option>)}</select></Field></li>}
        {preset === 'custom' && <li><Field label={t('cron')}><Input data-slot="schedule-cron" className="font-mono" required value={cron} onChange={(event) => setCron(event.target.value)} maxLength={256} /><span className="text-sm text-muted-foreground">{t('cronHint')}</span></Field></li>}
        <li><Field label={t('timeZone')}><Input data-slot="schedule-timezone" required value={timeZone} onChange={(event) => setTimeZone(event.target.value)} maxLength={100} placeholder="America/Sao_Paulo" /></Field></li>
        <li><Field label={t('timeout')}><Input data-slot="schedule-timeout" type="number" min={1} max={86400} step={1} required value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} /></Field></li>
        <li className="px-4 py-3"><label className="flex min-h-11 items-center gap-3"><input data-slot="schedule-enabled" type="checkbox" className="size-5 accent-primary" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>{t('enabled')}</span></label><p className="text-sm text-muted-foreground">{t('pausedDefault')}</p></li>
      </ListGroup>
      <div className="flex flex-col gap-3" data-slot="schedule-preview">
        <Button type="button" variant="secondary" aria-busy={previewLoading} disabled={previewLoading} onClick={() => void loadPreview()}>{previewLoading ? t('loading') : t('preview')}</Button>
        <ErrorNotice error={previewError} />
        {currentPreview !== null && <div className="text-sm text-muted-foreground">
          <p className="pb-1 font-medium">{timeZone}</p>
          <ol className="list-inside list-decimal" aria-label={t('preview')}>{currentPreview.map((value) => <li key={value}>{formatScheduleDate(value, timeZone, i18n.language)}</li>)}</ol>
        </div>}
      </div>
      <p id={warningId} data-slot="schedule-rights-warning" className="text-sm leading-6 text-muted-foreground">{t('rightsWarning')} {kind === 'agent' && t('agentWarning')}</p>
      {invalid && <ErrorNotice message={t('invalid')} />}
      <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>{t('cancel')}</Button><Button data-slot="schedule-save" type="submit" className="flex-1" disabled={kind === 'command' && !shells.some((item) => item.id === shell)}>{t('save')}</Button></div>
    </fieldset>
    {confirmation !== null && <ScheduleConfirm title={t('confirmSave')} description={confirmation.enabled ? t('confirmEnabled') : t('confirmPaused')} label={t('save')} busy={busy} error={error} onCancel={() => { setConfirmation(null); setError(null); }} onConfirm={() => void save()} />}
  </form>;
}
