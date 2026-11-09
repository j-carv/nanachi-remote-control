import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, CircleCheck, ListChecks } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PlanEntries } from './PlanCard.js';
import type { PlanEntry } from './reducer.js';

/** Keeps the agent's current plan within reach without covering the conversation or composer. */
export function PlanDock({ entries }: { entries: readonly PlanEntry[] }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  if (entries.length === 0) return null;

  const completed = entries.reduce((count, entry) => count + (entry.status === 'completed' ? 1 : 0), 0);
  const done = completed === entries.length;
  const current = entries.find((entry) => entry.status === 'in_progress')
    ?? entries.find((entry) => entry.status === 'pending');
  const Icon = done ? CircleCheck : ListChecks;

  return (
    <section data-slot="plan-dock" aria-label={t('plan.title')} className="shrink-0 overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        data-slot="plan-toggle"
        aria-label={t(expanded ? 'plan.hide' : 'plan.show')}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent"
      >
        <Icon className={cn('size-4 shrink-0', done ? 'text-success' : 'text-muted-foreground')} aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs font-medium text-muted-foreground">{t('plan.title')}</span>
          <span data-slot="plan-current" className="truncate text-sm">{done ? t('plan.done') : current?.content}</span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-label={t('plan.progress', { completed, total: entries.length })}>
          {completed}/{entries.length}
        </span>
        <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground', expanded && 'rotate-180')} aria-hidden="true" />
      </button>
      <div id={panelId} hidden={!expanded}>
        {expanded && (
          <div data-slot="plan-checklist" className="max-h-[min(28dvh,16rem)] overflow-y-auto overscroll-contain border-t border-border p-3">
            <PlanEntries entries={entries} />
          </div>
        )}
      </div>
    </section>
  );
}
