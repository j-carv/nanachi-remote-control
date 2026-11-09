import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Circle, CircleCheck, CircleDot, ListChecks, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlanEntry } from './reducer.js';

const MARK: Record<PlanEntry['status'], LucideIcon> = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CircleCheck,
};

const MARK_TONE: Record<PlanEntry['status'], string> = {
  pending: 'text-muted-foreground',
  in_progress: 'text-running',
  completed: 'text-success',
};

/** The mark of an entry. It pops in when the entry changes status; the status it first showed does not (history). */
function PlanMark({ status }: { status: PlanEntry['status'] }) {
  const { t } = useTranslation('chat');
  const [initialStatus] = useState(status);
  const Mark = MARK[status];
  return (
    <span
      role="img"
      aria-label={t(`status.${status}`)}
      className={cn('mt-px flex shrink-0 transition-colors duration-200 motion-reduce:transition-none', MARK_TONE[status])}
    >
      <Mark
        key={status}
        className={cn('size-5', status !== initialStatus && 'animate-enter-scale motion-reduce:animate-none')}
        aria-hidden="true"
      />
    </span>
  );
}

/** Shared checklist for the transcript card and the pinned plan above the composer. */
export function PlanEntries({ entries }: { entries: readonly PlanEntry[] }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {entries.map((entry, index) => (
        <li
          key={index}
          data-slot="plan-item"
          data-plan-status={entry.status}
          className={cn(
            'flex items-start gap-2.5 text-[15px] leading-snug [overflow-wrap:anywhere] transition-colors duration-200 motion-reduce:transition-none',
            entry.status === 'completed' && 'text-muted-foreground',
          )}
        >
          <PlanMark status={entry.status} />
          <span className="min-w-0">{entry.content}</span>
        </li>
      ))}
    </ul>
  );
}

/** Agent plan as a checklist in the transcript. */
export function PlanCard({ entries }: { entries: readonly PlanEntry[] }) {
  const { t } = useTranslation('chat');
  return (
    <section aria-label={t('plan.title')} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <ListChecks className="size-4" aria-hidden="true" />
        {t('plan.title')}
      </h2>
      <PlanEntries entries={entries} />
    </section>
  );
}
