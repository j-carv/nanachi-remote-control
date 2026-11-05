import { cx } from './cx.js';

/** A placeholder bar while data loads: a highlight sweeps over it. Static under reduced motion. */
export function Skeleton({ className }: { className?: string | undefined }) {
  return <div aria-hidden="true" className={cx('animate-shimmer rounded-md bg-muted', className)} />;
}
