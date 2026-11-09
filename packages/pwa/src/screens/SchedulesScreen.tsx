import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Schedule, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import type { Navigator } from '../navigation.js';
import { Button } from '@/components/ui/button';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton } from '../components/ListGroup.js';
import { useAsync } from '../useAsync.js';
import { ScheduleForm, scheduleInput, formatScheduleDate } from '../schedules/ScheduleForm.js';
import { ScheduleConfirm } from '../schedules/ScheduleConfirm.js';
import { ScheduleHistory } from '../schedules/ScheduleHistory.js';

type ScheduleView = { kind: 'list' } | { kind: 'edit'; schedule: Schedule | null } | { kind: 'history'; schedule: Schedule };
type ScheduleAction = { kind: 'toggle' | 'delete' | 'run'; schedule: Schedule };
export function ScheduleRows({ schedules, busy, onEdit, onHistory, onAction }: {
  schedules: Schedule[]; busy: boolean; onEdit(schedule: Schedule): void; onHistory(schedule: Schedule): void; onAction(action: ScheduleAction): void;
}) {
  const { t, i18n } = useTranslation('schedules');
  return <ListGroup label={t('title')}>{schedules.map((schedule) => <li data-slot="schedule-row" data-schedule-id={schedule.id} key={schedule.id}>
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="flex min-w-0 items-start gap-3"><CalendarClock className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="flex min-w-0 flex-1 flex-col gap-1"><h2 className="break-words font-medium">{schedule.name}</h2><p className="text-sm text-muted-foreground">{t(schedule.task.kind === 'agent' ? 'agentTask' : 'commandTask')} · {t(schedule.enabled ? 'active' : 'paused')}</p><p className="break-words font-mono text-sm text-muted-foreground">{schedule.cronExpression} · {schedule.timeZone}</p><p className="text-sm text-muted-foreground">{schedule.nextRunAt === null ? t('noNextRun') : t('nextRun', { date: formatScheduleDate(schedule.nextRunAt, schedule.timeZone, i18n.language) })}</p></div></div>
      <div className="flex flex-wrap gap-2"><Button variant="secondary" data-slot="schedule-edit" disabled={busy} onClick={() => onEdit(schedule)}>{t('edit')}</Button><Button variant="secondary" data-slot="schedule-history-open" disabled={busy} onClick={() => onHistory(schedule)}>{t('history')}</Button><Button variant="ghost" data-slot="schedule-toggle" disabled={busy} onClick={() => onAction({ kind: 'toggle', schedule })}>{t(schedule.enabled ? 'pause' : 'enable')}</Button><Button variant="ghost" data-slot="schedule-run-now" disabled={busy} onClick={() => onAction({ kind: 'run', schedule })}>{t('runNow')}</Button><Button variant="ghost" data-slot="schedule-delete" className="text-destructive" disabled={busy} onClick={() => onAction({ kind: 'delete', schedule })}>{t('delete')}</Button></div>
    </div>
  </li>)}</ListGroup>;
}

export function SchedulesScreen({ api, workspace, machineName, nav, onRepair }: { api: ApiClient; workspace: Workspace; machineName: string; nav: Navigator; onRepair(): void }) {
  const { t } = useTranslation('schedules');
  const list = useAsync(() => api.listSchedules(workspace.id), [api, workspace.id]);
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const accounts = useAsync(() => api.agentAccounts(false), [api]);
  const shells = useAsync(() => api.fetchShells(), [api]);
  const [confirmed, setConfirmed] = useState<Schedule[] | null>(null);
  const [view, setView] = useState<ScheduleView>({ kind: 'list' });
  const [pending, setPending] = useState<ScheduleAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef(true);
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => { heading.current?.focus(); }, [view.kind]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (list.data !== null) setConfirmed(list.data); }, [list.data]);
  useEffect(() => {
    if (view.kind !== 'list' || pending !== null) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') list.reload(); }, 15000);
    return () => clearInterval(timer);
  }, [view.kind, pending]);
  function saved(schedule: Schedule) {
    setConfirmed((previous) => previous?.some((item) => item.id === schedule.id) ? previous.map((item) => item.id === schedule.id ? schedule : item) : [...previous ?? [], schedule]);
    setView({ kind: 'list' });
  }
  async function perform() {
    if (pending === null || busy || !active.current) return;
    setBusy(true); setError(null);
    const { schedule, kind } = pending;
    try {
      if (kind === 'delete') {
        await api.deleteSchedule(workspace.id, schedule.id);
        if (active.current) setConfirmed((previous) => previous?.filter((item) => item.id !== schedule.id) ?? null);
      } else if (kind === 'toggle') {
        const updated = await api.updateSchedule(workspace.id, schedule.id, { ...scheduleInput(schedule), enabled: !schedule.enabled });
        if (active.current) setConfirmed((previous) => previous?.map((item) => item.id === schedule.id ? updated : item) ?? [updated]);
      } else {
        await api.runSchedule(workspace.id, schedule.id);
        if (active.current) setView({ kind: 'history', schedule });
      }
      if (active.current) setPending(null);
    } catch (caught) { if (active.current) setError(caught); }
    finally { if (active.current) setBusy(false); }
  }
  const confirmation = pending === null ? null : pending.kind === 'delete'
    ? { title: t('delete'), description: t('confirmDelete'), label: t('delete') }
    : pending.kind === 'run' ? { title: t('runNow'), description: t('confirmRun'), label: t('runNow') }
    : { title: t(pending.schedule.enabled ? 'pause' : 'enable'), description: t(pending.schedule.enabled ? 'confirmPause' : 'confirmEnabled'), label: t(pending.schedule.enabled ? 'pause' : 'enable') };
  const configError = agents.error ?? accounts.error ?? shells.error;
  const title = view.kind === 'list' ? t('title') : view.kind === 'edit' ? t(view.schedule === null ? 'new' : 'edit') : t('history');
  return <Screen>
    <div data-slot="schedules-screen" ref={heading} tabIndex={-1} aria-label={title} className="outline-none"><ScreenHeader title={title} subtitle={`${machineName} · ${workspace.name}`} onBack={() => view.kind === 'list' ? nav.back() : setView({ kind: 'list' })} actions={view.kind === 'list' ? <Button data-slot="schedule-new" size="icon" variant="ghost" aria-label={t('new')} title={t('new')} disabled={busy} onClick={() => setView({ kind: 'edit', schedule: null })}><Plus aria-hidden="true" /></Button> : undefined} /></div>
    {view.kind !== 'list' && <Button variant="secondary" data-slot="schedule-back-list" className="hidden self-start wide:inline-flex" onClick={() => setView({ kind: 'list' })}>{t('backToSchedules')}</Button>}
    {view.kind === 'list' && <>
      <p className="text-sm leading-6 text-muted-foreground">{t('intro')}</p>
      <Button data-slot="schedule-refresh-list" variant="secondary" className="self-start" disabled={list.loading || busy} onClick={list.reload}>{t('refresh')}</Button>
      <ErrorNotice error={list.error} onRepair={onRepair} action={{ label: t('retry'), onClick: list.reload }} />
      {confirmed === null && list.loading && <ListSkeleton label={t('loading')} />}
      {confirmed?.length === 0 && <div data-slot="schedules-empty" className="flex flex-col gap-4"><p className="text-muted-foreground">{t('empty')}</p><Button onClick={() => setView({ kind: 'edit', schedule: null })}>{t('new')}</Button></div>}
      {confirmed !== null && confirmed.length > 0 && <ScheduleRows schedules={confirmed} busy={busy} onEdit={(schedule) => setView({ kind: 'edit', schedule })} onHistory={(schedule) => setView({ kind: 'history', schedule })} onAction={(action) => { setPending(action); setError(null); }} />}
    </>}
    {view.kind === 'edit' && <>
      <ErrorNotice error={configError} onRepair={onRepair} action={{ label: t('retry'), onClick: () => { agents.reload(); accounts.reload(); shells.reload(); } }} />
      {(agents.loading || shells.loading || accounts.loading) && <p role="status" className="text-muted-foreground">{t('loading')}</p>}
      <ScheduleForm key={view.schedule?.id ?? 'new'} api={api} workspaceId={workspace.id} schedule={view.schedule} agents={agents.data ?? []} accounts={accounts.data ?? []} shells={shells.data ?? []} shellsLoading={shells.loading} onSaved={saved} onCancel={() => setView({ kind: 'list' })} />
    </>}
    {view.kind === 'history' && <><h2 className="break-words text-base font-medium">{view.schedule.name}</h2><ScheduleHistory api={api} workspace={workspace} schedule={view.schedule} nav={nav} onRepair={onRepair} /></>}
    {pending !== null && confirmation !== null && <ScheduleConfirm {...confirmation} busy={busy} error={error} destructive={pending.kind === 'delete'} onConfirm={() => void perform()} onCancel={() => { setPending(null); setError(null); }} />}
  </Screen>;
}
