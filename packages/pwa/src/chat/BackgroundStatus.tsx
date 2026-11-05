import { Check, CircleDashed, Square, X } from 'lucide-react';
import type { BackgroundJob } from '@nanachi/shared';
import { StatusDot } from '../components/StatusDot.js';
import { cn } from '@/lib/utils';
import { jobStateOf, type BackgroundState } from './background.js';

/* UI strings of the background states, in one place (the label a later i18n pass will replace). */
export const BACKGROUND_STATE_TEXT: Record<BackgroundState, string> = {
  running: 'Em andamento',
  completed: 'Concluído',
  failed: 'Falhou',
  stopped: 'Parado',
  unknown: 'Estado desconhecido',
};

/**
 * Glyph of a background state. Running is a pulsing dot (the only motion), completed a check, failed a cross, stopped
 * a filled square and unknown a dashed circle. Colour only on the success and failure marks, as DESIGN.md allows.
 */
function Glyph({ state }: { state: BackgroundState }) {
  switch (state) {
    case 'running':
      return <StatusDot tone="running" pulse />;
    case 'completed':
      return <Check className="size-4 shrink-0 text-success" aria-hidden="true" />;
    case 'failed':
      return <X className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
    case 'stopped':
      return <Square className="size-3.5 shrink-0 fill-current text-muted-foreground" aria-hidden="true" />;
    case 'unknown':
      return <CircleDashed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  }
}

interface BackgroundStatusProps {
  state: BackgroundState;
  /** Shows the state text next to the glyph. Without it, the glyph carries the state for assistive tech. */
  showText?: boolean;
}

export function BackgroundStatus({ state, showText = false }: BackgroundStatusProps) {
  return (
    <span
      data-slot="background-status"
      data-state={state}
      role={showText ? undefined : 'img'}
      aria-label={showText ? undefined : BACKGROUND_STATE_TEXT[state]}
      className={cn('flex shrink-0 items-center gap-1.5', showText && 'text-xs text-muted-foreground')}
    >
      <Glyph state={state} />
      {showText && <span>{BACKGROUND_STATE_TEXT[state]}</span>}
    </span>
  );
}

/** The jobs of a background item, each with its own status. Jobs of a parent that is no longer running read unknown. */
export function BackgroundJobRows({ jobs, parent }: { jobs: readonly BackgroundJob[]; parent: BackgroundState }) {
  if (jobs.length === 0) return null;
  return (
    <ul data-slot="background-jobs" className="flex flex-col pl-7">
      {jobs.map((job) => {
        const state = jobStateOf(job, parent);
        return (
          <li key={job.id} data-job-state={state} className="flex min-h-9 items-center gap-2.5 text-sm">
            <BackgroundStatus state={state} />
            <span className="min-w-0 flex-1 truncate">{job.label ?? job.id}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{BACKGROUND_STATE_TEXT[state]}</span>
          </li>
        );
      })}
    </ul>
  );
}
