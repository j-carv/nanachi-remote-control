import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from './cx.js';

/** One bordered surface with hairline-separated rows. Never a card per row, never a card inside a card. */
export function Group({ children, className, label }: { children: ReactNode; className?: string | undefined; label?: string | undefined }) {
  return (
    <div role={label ? 'group' : undefined} aria-label={label} className={cx('divide-y divide-border overflow-hidden rounded-lg border border-border bg-card', className)}>
      {children}
    </div>
  );
}

export interface RowProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls. */
  trailing?: ReactNode;
  /** Align to the top when the description wraps over several lines. */
  top?: boolean;
  id?: string | undefined;
  className?: string | undefined;
}

/** A row of a group: optional icon tile, title, one muted line, controls on the right. 48 px at least. */
export function Row({ icon: Icon, title, description, trailing, top = false, id, className }: RowProps) {
  return (
    <div className={cx('flex min-h-12 gap-3 px-4 py-2.5', top ? 'items-start' : 'items-center', className)}>
      {Icon ? (
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
          <Icon aria-hidden="true" />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div id={id} className="text-sm leading-5 font-medium">
          {title}
        </div>
        {description ? <div className="text-[13px] leading-5 text-muted-foreground">{description}</div> : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-1.5">{trailing}</div> : null}
    </div>
  );
}

/** Heading of a group: quiet, sentence case, with an optional action on the right. */
export function SectionHeading({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string | undefined }) {
  return (
    <div className="mb-2 flex min-h-8 items-center justify-between gap-3 px-0.5">
      <h2 id={id} className="text-[13px] leading-5 font-medium text-muted-foreground">
        {children}
      </h2>
      {action}
    </div>
  );
}

/** Label and value, for the facts of a row (`Port 7780`). Numbers line up. */
export function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={cx('text-foreground tabular-nums', mono && 'font-mono text-[12px]')}>{children}</span>
    </span>
  );
}
