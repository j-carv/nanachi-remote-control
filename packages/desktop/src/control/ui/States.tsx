import { CircleAlert, Link2Off, RotateCw, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ControlError } from '../../common/control-api.js';
import { calmErrorHint, errorMessage, errorTitle, isCalmError } from '../lib/errors.js';
import { Button } from './Button.js';
import { Group } from './Surface.js';
import { Skeleton } from './Skeleton.js';

/** A section that could not load: what happened (the message from main, already in the language of the page) and the way out. */
export function ErrorState({ error, onRetry }: { error: ControlError; onRetry: () => void }) {
  const { t } = useTranslation();
  // Attached to a daemon Desktop did not start, parts of the panel are unavailable by design: say so calmly.
  const calm = isCalmError(error.code);
  return (
    <div role={calm ? 'status' : 'alert'} data-calm={calm} className="flex flex-col items-center gap-1 px-6 py-16 text-center">
      <span
        className={`mb-3 grid size-10 place-items-center rounded-full [&_svg]:size-5 ${calm ? 'bg-muted text-muted-foreground' : 'bg-destructive/10 text-destructive'}`}
      >
        {calm ? <Link2Off aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      </span>
      <h2 className="font-display text-[15px] font-semibold">{errorTitle(error.code, t)}</h2>
      <p className="max-w-[440px] text-[13px] leading-5 text-muted-foreground">{errorMessage(error, t)}</p>
      {calm ? <p className="max-w-[440px] text-[13px] leading-5 text-muted-foreground">{calmErrorHint(t)}</p> : null}
      <Button className="mt-4" icon={<RotateCw aria-hidden="true" />} onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

/** Nothing to list yet: one line on what this is and, when there is one, the action that fills it. */
export function EmptyState({ icon: Icon, title, description, action }: { icon: LucideIcon; title: string; description: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-12 text-center">
      <span className="mb-3 grid size-10 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
        <Icon aria-hidden="true" />
      </span>
      <h3 className="font-display text-[15px] font-semibold">{title}</h3>
      <p className="max-w-[420px] text-[13px] leading-5 text-muted-foreground">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Skeleton rows in a group, while a list loads. `aria-busy` tells assistive tech the content is on its way. */
export function GroupSkeleton({ rows = 3, className }: { rows?: number; className?: string | undefined }) {
  const { t } = useTranslation();
  return (
    <Group className={className}>
      <div aria-busy="true" aria-label={t('common.loading')} role="status" className="divide-y divide-border">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex h-12 items-center gap-3 px-4">
            <Skeleton className="size-8 shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </Group>
  );
}
