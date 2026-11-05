import type { Tone } from '../lib/status.js';
import { cx } from './cx.js';
import { TONE_DOT } from './tone.js';

/** A small status dot. Decorative: the state is always written next to it. A running state breathes softly; a tone change cross-fades. */
export function StatusDot({ tone, pulse = false, className }: { tone: Tone; pulse?: boolean; className?: string | undefined }) {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block size-2 shrink-0 rounded-full transition-colors duration-300 ease-[var(--ease-premium)]', TONE_DOT[tone], pulse && 'animate-breathe', className)}
    />
  );
}
