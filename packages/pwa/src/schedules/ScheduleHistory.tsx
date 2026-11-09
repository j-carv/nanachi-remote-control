import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Schedule, ScheduleRun } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import type { Navigator } from '../navigation.js';
import type { Workspace } from '@nanachi/shared';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton } from '../components/ListGroup.js';
import { ScheduleConfirm } from './ScheduleConfirm.js';
import { formatScheduleDate } from './ScheduleForm.js';

export function isActiveRun(run: ScheduleRun): boolean { return run.status === 'running' || run.status === 'awaiting_permission'; }
export function ScheduleRunDetails({ run, busy, onCancel, onOpen }: { run: ScheduleRun; busy: boolean; onCancel(): void; onOpen(): void }) {
  const { t } = useTranslation('schedules');
  return <div data-slot="schedule-run-details" className="flex min-w-0 flex-col gap-3 px-4 pb-4">
    <p className="text-sm text-muted-foreground">{t(run.trigger === 'manual' ? 'manualTrigger' : 'scheduledTrigger')}</p>
    <p className="whitespace-pre-wrap break-words text-sm">{run.task.kind === 'command' ? `${run.task.shell}\n${run.task.command}` : `${run.task.agentId} · ${run.task.accountId}\n${run.task.model || t('agentDefault')}\n${run.task.prompt}`}</p>
    {run.status === 'awaiting_permission' && <p className="text-sm text-attention">{t('approvalHint')}</p>}
    {run.error !== null && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">{run.error}</p>}
    {run.exitCode !== null && <p className="text-sm text-muted-foreground">{t('exitCode', { code: run.exitCode })}</p>}
    <div className="flex flex-wrap gap-2">
      {run.task.kind === 'agent' && run.sessionId !== null && <Button data-slot="schedule-open-execution" variant="secondary" disabled={busy} onClick={onOpen}>{t('openExecution')}</Button>}
      {isActiveRun(run) && <Button data-slot="schedule-cancel-run" variant="secondary" disabled={busy} onClick={onCancel}>{t('cancelRun')}</Button>}
    </div>
    <h3 className="text-sm font-medium">{t('output')}</h3>
    {run.outputTruncated && <p className="text-sm text-muted-foreground">{t('outputTruncated')}</p>}
    {run.output ? <pre data-slot="schedule-run-output" className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-sm">{run.output}</pre> : <p className="text-sm text-muted-foreground">{t('noOutput')}</p>}
  </div>;
}

export function ScheduleHistory({ api, workspace, schedule, nav, onRepair }: { api: ApiClient; workspace: Workspace; schedule: Schedule; nav: Navigator; onRepair(): void }) {
  const { t, i18n } = useTranslation('schedules');
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingCancel, setPendingCancel] = useState<ScheduleRun | null>(null);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const active = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    active.current = true;
    let disposed = false;
    let timer: number | undefined;
    async function refresh() {
      const requestedRevision = revision.current;
      try {
        const result = await api.scheduleRuns(workspace.id, schedule.id);
        if (!disposed && requestedRevision === revision.current) { setRuns(result); setError(null); }
      } catch (caught) { if (!disposed) setError(caught); }
      finally {
        if (!disposed) {
          setLoading(false);
          timer = window.setTimeout(() => void refresh(), document.visibilityState === 'visible' ? 2000 : 10000);
        }
      }
    }
    void refresh();
    return () => { disposed = true; active.current = false; clearTimeout(timer); };
  }, [api, workspace.id, schedule.id, reload]);
  async function open(run: ScheduleRun) {
    if (busy || run.sessionId === null) return;
    setBusy(true); setError(null);
    try {
      const session = await api.fetchSession(run.sessionId);
      if (active.current && session.workspaceId === workspace.id) nav.push({ kind: 'chat', workspace, session });
    } catch (caught) { if (active.current) setError(caught); }
    finally { if (active.current) setBusy(false); }
  }
  async function cancel() {
    if (busy || pendingCancel === null) return;
    setBusy(true); setCancelError(null);
    try {
      const confirmed = await api.cancelScheduleRun(workspace.id, schedule.id, pendingCancel.id);
      if (active.current) { revision.current++; setRuns((previous) => previous?.map((run) => run.id === confirmed.id ? confirmed : run) ?? [confirmed]); setPendingCancel(null); }
    } catch (caught) { if (active.current) setCancelError(caught); }
    finally { if (active.current) setBusy(false); }
  }
  return <section data-slot="schedule-history" className="flex min-w-0 flex-col gap-4" aria-label={t('history')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted-foreground">{t('historyHint')}</p><Button variant="secondary" data-slot="schedule-refresh-history" disabled={loading} onClick={() => { setLoading(true); setReload((value) => value + 1); }}>{t('refresh')}</Button></div>
    <ErrorNotice error={error} onRepair={onRepair} action={{ label: t('retry'), onClick: () => { setLoading(true); setReload((value) => value + 1); } }} />
    {runs === null && loading && <ListSkeleton label={t('loading')} />}
    {runs?.length === 0 && <p className="text-muted-foreground">{t('emptyHistory')}</p>}
    {runs !== null && runs.length > 0 && <ListGroup label={t('history')}>
      {runs.map((run) => <li key={run.id} data-slot="schedule-run" data-run-id={run.id} data-status={run.status}>
        <button type="button" className="flex min-h-14 w-full flex-col gap-1 px-4 py-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" aria-expanded={selected === run.id} onClick={() => setSelected((previous) => previous === run.id ? null : run.id)}>
          <span className={run.status === 'awaiting_permission' ? 'text-attention' : run.status === 'failed' || run.status === 'timed_out' ? 'text-destructive' : ''}>{t(`statuses.${run.status}`)}</span>
          <span className="text-sm text-muted-foreground">{formatScheduleDate(run.scheduledAt, schedule.timeZone, i18n.language)} · {schedule.timeZone}</span>
        </button>
        {selected === run.id && <ScheduleRunDetails run={run} busy={busy} onOpen={() => void open(run)} onCancel={() => setPendingCancel(run)} />}
      </li>)}
    </ListGroup>}
    {pendingCancel !== null && <ScheduleConfirm title={t('cancelRun')} description={t('confirmCancel')} label={t('cancelRun')} busy={busy} error={cancelError} destructive onCancel={() => { setPendingCancel(null); setCancelError(null); }} onConfirm={() => void cancel()} />}
  </section>;
}
