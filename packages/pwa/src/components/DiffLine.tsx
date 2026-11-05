import { cn } from '@/lib/utils';

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

/**
 * Added and removed lines take the status tones at 10% alpha: the foreground text stays at full contrast and
 * only the background shows the change. Context stays plain; hunk and file headers are muted.
 */
const KIND_CLASS: Record<DiffLineKind, string> = {
  add: 'bg-success/10',
  del: 'bg-destructive/10',
  ctx: '',
  hunk: 'bg-muted text-muted-foreground',
  meta: 'text-muted-foreground',
};

/** Body of a diff: monospace, its own horizontal and vertical scroll, capped height. */
export const diffBodyClass =
  'm-0 max-h-[360px] overflow-auto overscroll-contain py-1.5 font-mono text-[13px] leading-5';

interface DiffLineProps {
  kind: DiffLineKind;
  children: string;
}

/**
 * One line of a diff. Each line is as wide as the longest one, so its background follows a horizontal scroll.
 * `data-kind` is the hook the tests and the e2e scripts read.
 */
export function DiffLine({ kind, children }: DiffLineProps) {
  return (
    <span
      data-slot="diff-line"
      data-kind={kind}
      className={cn('block w-max min-w-full px-3 whitespace-pre', KIND_CLASS[kind])}
    >
      {children}
    </span>
  );
}
