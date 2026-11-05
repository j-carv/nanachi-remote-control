import { Repeat } from 'lucide-react';
import type { Loop } from '@nanachi/shared';
import { cn } from '@/lib/utils';
import { loopChipView, type LoopPhase } from './loop.js';
import { useLoopClock } from './useLoopClock.js';

/** Icon colour per phase. Only error and running get a colour (DESIGN.md: colour only for status). */
const PHASE_ICON: Record<LoopPhase, string> = {
  countdown: 'text-foreground',
  running: 'text-running',
  queued: 'text-muted-foreground',
  paused: 'text-muted-foreground',
  error: 'text-destructive',
};

interface LoopChipProps {
  loop: Loop | null;
  onOpen(): void;
}

/**
 * Loop Mode chip, in the header's lower row next to the background chip. Shows the countdown to the next round (it
 * ticks while the app is visible). A tap opens the sheet. Renders nothing without a loop (or with a stopped one).
 */
export function LoopChip({ loop, onOpen }: LoopChipProps) {
  const now = useLoopClock(loop !== null);
  const view = loopChipView(loop, now);
  if (view === undefined) return null;
  const running = view.phase === 'running';

  return (
    <button
      type="button"
      data-slot="loop-chip"
      data-phase={view.phase}
      aria-label={`${view.label}. Abrir o Modo Loop`}
      aria-haspopup="dialog"
      onClick={onOpen}
      className="-my-2.5 flex min-w-0 shrink-0 items-center py-2.5"
    >
      <span className="flex h-6 max-w-full items-center gap-1 rounded-full bg-secondary px-2 text-xs font-medium whitespace-nowrap tabular-nums text-foreground">
        <Repeat
          className={cn('size-3.5 shrink-0', PHASE_ICON[view.phase], running && 'animate-spin motion-reduce:animate-none')}
          aria-hidden="true"
        />
        {/* Below 360 px the full text does not fit beside the background chip, so the short form shows. */}
        <span className="max-[359px]:hidden">{view.label}</span>
        <span className="hidden max-[359px]:inline">{view.short}</span>
      </span>
    </button>
  );
}
