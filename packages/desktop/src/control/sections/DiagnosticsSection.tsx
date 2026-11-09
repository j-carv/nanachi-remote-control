import { Copy, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from '../lib/clipboard.js';
import { buildDiagnosticsReport, reachabilityAddress, shownLogLines, type DiagnosticsSnapshot } from '../lib/diagnostics.js';
import { formatDateTime } from '../lib/format.js';
import { daemonSummary, tailscaleSummary, type StatusSummary } from '../lib/status.js';
import { useShell } from '../state/shell.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Notice } from '../ui/Notice.js';
import { StatusDot } from '../ui/StatusDot.js';
import { ErrorState, GroupSkeleton } from '../ui/States.js';
import { Group, SectionHeading } from '../ui/Surface.js';
import { useToast } from '../ui/Toast.js';
import { TONE_TEXT } from '../ui/tone.js';
import { Page } from './Page.js';

/** One read-only fact: its label, then the value (selectable, so a value can also be copied by hand). */
function Field({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 px-4 py-2.5">
      <span className="w-44 shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className={cx('selectable min-w-0 flex-1 break-all text-sm', mono && 'font-mono text-[12.5px]')}>{children}</span>
    </div>
  );
}

/** A group of facts under its heading. */
function Block({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <SectionHeading id={id} action={action}>
        {title}
      </SectionHeading>
      {children}
    </section>
  );
}

function StatusWord({ summary }: { summary: StatusSummary }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5', TONE_TEXT[summary.tone])}>
      <StatusDot tone={summary.tone} pulse={summary.pulse} />
      {summary.word}
    </span>
  );
}

export interface DiagnosticsViewProps {
  snapshot: DiagnosticsSnapshot;
  /** The log lines are being read: the snapshot has none yet. */
  logsLoading: boolean;
  /** The Refresh button is waiting for the overview and the logs. */
  refreshing: boolean;
  onRefresh: () => void;
}

/** The page's facts, as plain data in and a callback out. The same redaction as the report applies to the log lines. */
export function DiagnosticsView({ snapshot, logsLoading, refreshing, onRefresh }: DiagnosticsViewProps) {
  const { t } = useTranslation();
  const { daemon, tailscale, activity } = snapshot;
  const notAvailable = t('diagnostics.notAvailable');
  const yesNo = (value: boolean): string => (value ? t('diagnostics.yes') : t('diagnostics.no'));
  const syncedAt = (ms: number | null): string => (ms === null ? t('diagnostics.notYet') : formatDateTime(ms, t));
  const address = reachabilityAddress(tailscale);
  const logLines = snapshot.logLines === null ? null : shownLogLines(snapshot.logLines);

  return (
    <>
      <Block id="diagnostics-app" title={t('diagnostics.groups.app')}>
        <Group>
          <Field label={t('diagnostics.rows.version')}>{snapshot.appVersion}</Field>
          <Field label={t('diagnostics.rows.platform')}>{snapshot.platform ?? notAvailable}</Field>
          <Field label={t('diagnostics.rows.dataFolder')} mono>
            {snapshot.dataFolder}
          </Field>
        </Group>
      </Block>

      <Block id="diagnostics-daemon" title={t('diagnostics.groups.daemon')}>
        <Group>
          <Field label={t('diagnostics.rows.state')}>
            <StatusWord summary={daemonSummary(daemon, t)} />
          </Field>
          <Field label={t('diagnostics.rows.port')}>{daemon.port}</Field>
          <Field label={t('diagnostics.rows.mode')}>{t(`diagnostics.mode.${daemon.mode}`)}</Field>
          <Field label={t('diagnostics.rows.pid')}>{daemon.pid ?? t('diagnostics.none')}</Field>
          <Field label={t('diagnostics.rows.daemonVersion')}>{daemon.version ?? notAvailable}</Field>
          <Field label={t('diagnostics.rows.restricted')}>{yesNo(daemon.restricted)}</Field>
          <Field label={t('diagnostics.rows.machineName')}>{daemon.machineName ?? notAvailable}</Field>
          <Field label={t('diagnostics.rows.lastMessage')}>{daemon.message ?? t('diagnostics.none')}</Field>
        </Group>
      </Block>

      <Block id="diagnostics-tailscale" title={t('diagnostics.groups.tailscale')}>
        <Group>
          <Field label={t('diagnostics.rows.state')}>
            <StatusWord summary={tailscaleSummary(tailscale, t)} />
          </Field>
          {tailscale.state === 'running' ? (
            <>
              <Field label={t('diagnostics.rows.dnsName')} mono>
                {tailscale.dnsName}
              </Field>
              <Field label={t('diagnostics.rows.tailnet')}>{tailscale.tailnet}</Field>
              <Field label={t('diagnostics.rows.ips')} mono>
                {tailscale.ips.join(', ') || t('diagnostics.none')}
              </Field>
            </>
          ) : null}
          {tailscale.state === 'error' ? <Field label={t('diagnostics.rows.message')}>{tailscale.message}</Field> : null}
          <Field label={t('diagnostics.rows.builtIn')}>{t('diagnostics.rows.builtInValue')}</Field>
        </Group>
      </Block>

      <Block id="diagnostics-reachability" title={t('diagnostics.groups.reachability')}>
        <Group>
          <Field label={t('common.addressForPhone')} mono>
            {address ?? notAvailable}
          </Field>
        </Group>
      </Block>

      <Block id="diagnostics-activity" title={t('diagnostics.groups.activity')}>
        {activity ? (
          <Group>
            <Field label={t('diagnostics.rows.workspaces')}>{activity.workspaces}</Field>
            <Field label={t('diagnostics.rows.sessions')}>{activity.sessions}</Field>
            <Field label={t('diagnostics.rows.busySessions')}>{activity.busySessions}</Field>
            <Field label={t('diagnostics.rows.devices')}>{activity.devices}</Field>
          </Group>
        ) : (
          <Notice>{t('overview.activityUnavailable')}</Notice>
        )}
      </Block>

      <Block
        id="diagnostics-sync"
        title={t('diagnostics.groups.sync')}
        action={
          <Button icon={<RefreshCw aria-hidden="true" />} loading={refreshing} onClick={onRefresh}>
            {t('diagnostics.refresh')}
          </Button>
        }
      >
        <Group>
          <Field label={t('diagnostics.rows.overviewSynced')}>{syncedAt(snapshot.overviewSyncedAt)}</Field>
          <Field label={t('diagnostics.rows.daemonEvent')}>{syncedAt(snapshot.daemonEventAt)}</Field>
        </Group>
      </Block>

      <Block id="diagnostics-logs" title={t('diagnostics.groups.logs')}>
        {logLines === null ? (
          logsLoading ? (
            <GroupSkeleton rows={3} />
          ) : (
            <Notice>{t('diagnostics.logsUnavailable')}</Notice>
          )
        ) : logLines.length === 0 ? (
          <Notice>{t('logs.emptyDaemon')}</Notice>
        ) : (
          <Group>
            <pre className="selectable max-h-80 overflow-auto p-4 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-foreground">{logLines.join('\n')}</pre>
          </Group>
        )}
      </Block>

      <p className="text-[13px] leading-5 text-muted-foreground">{t('diagnostics.reportNote')}</p>
    </>
  );
}

function DiagnosticsSkeleton() {
  return (
    <>
      <GroupSkeleton rows={3} />
      <GroupSkeleton rows={4} />
      <GroupSkeleton rows={2} />
    </>
  );
}

/** The browser's name for the platform (`Win32` on Windows), or null when there is none. */
function platformName(): string | null {
  return typeof navigator === 'undefined' ? null : navigator.platform || null;
}

export function DiagnosticsSection() {
  const { t } = useTranslation();
  const shell = useShell();
  const toast = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const { reloadOverview, reloadLogs } = shell;

  // Opening the section asks main again for the overview and the logs: the page then shows what main knows now.
  useEffect(() => {
    void reloadOverview(true);
    void reloadLogs(true);
  }, [reloadOverview, reloadLogs]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await Promise.all([reloadOverview(true), reloadLogs(true)]);
    } finally {
      setRefreshing(false);
    }
  };

  const overview = shell.overview;
  let body: ReactNode;
  let actions: ReactNode = null;
  if (overview.status === 'loading') {
    body = <DiagnosticsSkeleton />;
  } else if (overview.status === 'error') {
    body = <ErrorState error={overview.error} onRetry={() => void reloadOverview()} />;
  } else {
    // The daemon and Tailscale values are the live ones (kept by the events in the shell); the overview adds the rest.
    const snapshot: DiagnosticsSnapshot = {
      generatedAt: Date.now(),
      appVersion: overview.data.appVersion,
      platform: platformName(),
      dataFolder: overview.data.dataFolder,
      daemon: shell.daemon ?? overview.data.daemon,
      tailscale: shell.tailscale ?? overview.data.tailscale,
      activity: overview.data.activity,
      overviewSyncedAt: shell.overviewSyncedAt,
      daemonEventAt: shell.daemonEventAt,
      logLines: shell.logs.status === 'ready' ? shell.logs.data.daemon : null,
    };
    const copy = async (): Promise<void> => {
      // The report is made from what the page shows now, stamped with the moment of the copy.
      const report = buildDiagnosticsReport({ ...snapshot, generatedAt: Date.now() });
      if (await copyText(report)) toast({ tone: 'success', message: t('diagnostics.copied') });
      else toast({ tone: 'error', message: t('common.copyFailed') });
    };
    actions = (
      <Button variant="primary" icon={<Copy aria-hidden="true" />} onClick={() => void copy()}>
        {t('diagnostics.copyReport')}
      </Button>
    );
    body = <DiagnosticsView snapshot={snapshot} logsLoading={shell.logs.status === 'loading'} refreshing={refreshing} onRefresh={() => void refresh()} />;
  }

  return (
    <Page section="diagnostics" actions={actions}>
      {body}
    </Page>
  );
}
