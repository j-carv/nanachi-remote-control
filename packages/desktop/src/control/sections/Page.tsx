import type { ReactNode } from 'react';
import type { ControlSection } from '../../common/control-api.js';
import { sectionMeta } from '../shell/nav.js';

/** Title, one muted line and the page's primary actions on the right. The `h1` takes the focus when the section changes. */
export function Page({ section, actions, fill = false, children }: { section: ControlSection; actions?: ReactNode; fill?: boolean; children: ReactNode }) {
  const meta = sectionMeta(section);
  return (
    <>
      <header className="mb-6 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 id="page-title" tabIndex={-1} className="font-display text-[22px] leading-7 font-semibold tracking-[-0.011em] outline-none">
            {meta.label}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{meta.description}</p>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2 pt-0.5">{actions}</div> : null}
      </header>
      <div className={fill ? 'flex min-h-0 flex-1 flex-col gap-6' : 'flex flex-col gap-6'}>{children}</div>
    </>
  );
}
