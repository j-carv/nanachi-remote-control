import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx.js';

export type NoticeTone = 'info' | 'attention' | 'destructive';

const STYLE: Record<NoticeTone, { surface: string; icon: ReactNode }> = {
  info: { surface: 'bg-card', icon: <Info className="text-muted-foreground" aria-hidden="true" /> },
  attention: { surface: 'bg-attention/8', icon: <TriangleAlert className="text-attention" aria-hidden="true" /> },
  destructive: { surface: 'bg-destructive/8', icon: <CircleAlert className="text-destructive" aria-hidden="true" /> },
};

/** An inline message with a status icon and an optional action. A hairline border all round, never a coloured edge. */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { surface, icon } = STYLE[tone];
  return (
    <div role={tone === 'info' ? undefined : 'alert'} className={cx('flex items-start gap-3 rounded-lg border border-border px-3.5 py-3', surface, className)}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1 text-[13px] leading-5">
        {title ? <div className="font-medium text-foreground">{title}</div> : null}
        {children ? <div className={title ? 'text-muted-foreground' : 'text-foreground'}>{children}</div> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
