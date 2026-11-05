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

const LABEL: Record<PlanEntry['status'], string> = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  completed: 'Concluído',
};

function PlanMark({ status }: { status: PlanEntry['status'] }) {
  const Mark = MARK[status];
  return (
    <span role="img" aria-label={LABEL[status]} className={cn('mt-px flex shrink-0', MARK_TONE[status])}>
      <Mark className="size-5" aria-hidden="true" />
    </span>
  );
}

/** Plano do agente como checklist. */
export function PlanCard({ entries }: { entries: readonly PlanEntry[] }) {
  return (
    <section aria-label="Plano" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <ListChecks className="size-4" aria-hidden="true" />
        Plano
      </h2>
      <ul className="flex flex-col gap-2.5">
        {entries.map((entry, index) => (
          <li
            key={index}
            data-slot="plan-item"
            data-plan-status={entry.status}
            className={cn(
              'flex items-start gap-2.5 text-[15px] leading-snug',
              entry.status === 'completed' && 'text-muted-foreground',
            )}
          >
            <PlanMark status={entry.status} />
            <span>{entry.content}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
