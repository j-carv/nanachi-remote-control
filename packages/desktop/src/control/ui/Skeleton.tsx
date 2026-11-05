import { cx } from './cx.js';

/** A placeholder bar while data loads. Pulses; static under reduced motion. */
export function Skeleton({ className }: { className?: string | undefined }) {
  return <div aria-hidden="true" className={cx('animate-pulse rounded-md bg-muted', className)} />;
}
