import { ShieldExclamationPoint } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Session, SessionStatus } from '@nanachi/shared';
import type { ConnectionStatus } from '../connection.js';
import type { SessionTarget } from '../push/notificationRoute.js';
import {
  countSessions,
  lastActivity,
  featuredSessions,
  sessionGroup,
  type MachineDetails,
  type MachineOverview,
} from '../machineOverview.js';
import type { Machine } from '../machines.js';
import { formatRelativeTime } from '../relativeTime.js';
import { displaySessionTitle } from '../sessionText.js';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { StatusDot, TONE_TEXT, type StatusTone } from './StatusDot.js';

interface MachineCardProps {
  machine: Machine;
  /** `undefined` while the first load runs. */
  overview: MachineOverview | undefined;
  connection: ConnectionStatus;
  selected: boolean;
  /** Epoch ms, for the relative times. */
  now: number;
  onSelect(): void;
  onOpenSession(target: SessionTarget): void;
}

interface HeaderStatus {
  label: string;
  tone: StatusTone;
  pulse: boolean;
}

function headerStatus(
  connection: ConnectionStatus,
  overview: MachineOverview | undefined,
  t: TFunction<'machines'>,
): HeaderStatus {
  if (connection === 'unauthorized') return { label: t('status.unauthorized.label'), tone: 'danger', pulse: false };
  if (overview === undefined) return { label: t('card.checking'), tone: 'muted', pulse: true };
  if (overview.status === 'offline') return { label: t('status.offline.label'), tone: 'muted', pulse: false };
  const latencyMs = overview.status === 'ready' ? overview.details.latencyMs : overview.latencyMs;
  return { label: t('card.online', { latencyMs }), tone: 'success', pulse: false };
}

const ROW_TONE: Record<SessionStatus, StatusTone> = {
  starting: 'muted',
  idle: 'muted',
  running: 'running',
  awaiting_permission: 'attention',
  stopped: 'muted',
  error: 'danger',
};

function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/** Placeholder lines while the machine's first load runs. Pulses (state, not decoration), stops under reduced motion. */
function CardSkeleton() {
  const { t } = useTranslation('machines');
  return (
    <div className="flex flex-col gap-2.5 motion-safe:animate-pulse">
      <span className="sr-only">{t('card.loading')}</span>
      <div className="h-3 w-3/4 rounded bg-muted" />
      <div className="h-3 w-1/2 rounded bg-muted" />
      <div className="h-3 w-2/3 rounded bg-muted" />
    </div>
  );
}

function ReadyBody({
  machineId,
  details,
  now,
  onOpenSession,
}: {
  machineId: string;
  details: MachineDetails;
  now: number;
  onOpenSession(target: SessionTarget): void;
}) {
  const { t } = useTranslation('machines');
  if (details.workspaceCount === 0) {
    return <p className="text-sm text-muted-foreground">{t('card.noWorkspaces')}</p>;
  }

  const counts = countSessions(details.sessions);
  const last = lastActivity(details.sessions);
  const rows = featuredSessions(details.sessions);

  return (
    <>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>{t('card.workspaces', { count: details.workspaceCount })}</span>
        {counts.running > 0 && <span>{t('summary.running', { count: counts.running })}</span>}
        {counts.awaiting > 0 && (
          <span className="flex items-center gap-1 font-medium text-attention">
            <ShieldExclamationPoint className="size-4" aria-hidden="true" />
            {t('summary.awaiting', { count: counts.awaiting })}
          </span>
        )}
        {counts.idle > 0 && <span>{t('card.idle', { count: counts.idle })}</span>}
      </p>

      <p className="text-sm text-muted-foreground">
        {last === null ? t('card.noSessions') : t('card.lastActivity', { time: formatRelativeTime(last, now) })}
      </p>

      {details.agents.length > 0 && (
        <ul aria-label={t('card.agents')} className="flex flex-wrap gap-1.5">
          {details.agents.map((agent) => (
            <li key={agent}>
              <Badge variant="outline" className="text-xs font-normal">
                {agent}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <ul aria-label={t('card.sessions')} className="-mx-1 flex flex-col">
          {rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              now={now}
              onOpen={() => onOpenSession({ machineId, workspaceId: session.workspaceId, sessionId: session.id })}
            />
          ))}
        </ul>
      )}

    </>
  );
}

function SessionRow({ session, now, onOpen }: { session: Session; now: number; onOpen(): void }) {
  const { t } = useTranslation('machines');
  const awaiting = sessionGroup(session.status) === 'awaiting';
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent"
      >
        <StatusDot tone={ROW_TONE[session.status]} />
        <span className={cn('min-w-0 flex-1 truncate text-base', awaiting && 'font-medium')}>{displaySessionTitle(session.title)}</span>
        <span className={cn('shrink-0 text-sm', awaiting ? TONE_TEXT.attention : 'text-muted-foreground')}>
          {awaiting ? t('card.awaitingPermission') : formatRelativeTime(session.updatedAt, now)}
        </span>
      </button>
    </li>
  );
}

/** One machine on the home screen: status and latency, counts by session state, recent sessions, logged-in agents. */
export function MachineCard({ machine, overview, connection, selected, now, onSelect, onOpenSession }: MachineCardProps) {
  const { t } = useTranslation('machines');
  const status = headerStatus(connection, overview, t);

  return (
    <li
      className={cn(
        'overflow-hidden rounded-xl border bg-card/80',
        selected ? 'border-foreground/30' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring active:bg-accent"
      >
        <StatusDot tone={status.tone} pulse={status.pulse} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{machine.name}</span>
          <span className="block truncate text-sm text-muted-foreground">
            {hostOf(machine.baseUrl)} · <span className={TONE_TEXT[status.tone]}>{status.label}</span>
          </span>
        </span>
      </button>

      <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
        {connection === 'unauthorized' ? (
          <p className="text-sm text-muted-foreground">{t('card.unauthorized')}</p>
        ) : overview === undefined ? (
          <CardSkeleton />
        ) : overview.status === 'offline' ? (
          <p className="text-sm text-muted-foreground">{t('card.noResponse')}</p>
        ) : overview.status === 'error' ? (
          <p className="text-sm text-muted-foreground">{t('card.loadFailed')}</p>
        ) : (
          <ReadyBody machineId={machine.id} details={overview.details} now={now} onOpenSession={onOpenSession} />
        )}
      </div>
    </li>
  );
}
