import type { ReactNode } from 'react';
import type { Tone } from '../lib/status.js';
import { cx } from './cx.js';
import { TONE_TEXT, TONE_TINT } from './tone.js';

/** A short label. `outline` is the neutral one; a tone is only for a status. */
export function Badge({ children, tone, className }: { children: ReactNode; tone?: Tone | 'outline' | undefined; className?: string | undefined }) {
  const style = tone === undefined || tone === 'outline' ? 'border border-border text-muted-foreground' : cx(TONE_TINT[tone], TONE_TEXT[tone]);
  return (
    <span className={cx('inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] leading-none font-medium whitespace-nowrap', style, className)}>
      {children}
    </span>
  );
}
