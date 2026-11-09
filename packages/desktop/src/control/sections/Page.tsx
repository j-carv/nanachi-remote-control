import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ControlSection } from '../../common/control-api.js';

/**
 * Title, one muted line and the page's primary actions on the right. The `h1` takes the focus when the section changes.
 * The app mark sits beside the title: `./icon.png` is the app artwork that the build copies next to `index.html` (the same
 * file the title bar uses). It is decorative, so its alt text is empty.
 */
export function Page({ section, actions, fill = false, children }: { section: ControlSection; actions?: ReactNode; fill?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      <header className="mb-6 flex items-start justify-between gap-6">
        <div className="flex min-w-0 items-start gap-3">
          <img src="./icon.png" alt="" draggable={false} className="mt-0.5 size-6 shrink-0 rounded-[5px] select-none" />
          <div className="min-w-0">
            <h1 id="page-title" tabIndex={-1} className="font-display text-[22px] leading-7 font-semibold tracking-[-0.011em] outline-none">
              {t(`sections.${section}.label`)}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{t(`sections.${section}.description`)}</p>
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2 pt-0.5">{actions}</div> : null}
      </header>
      <div className={fill ? 'flex min-h-0 flex-1 flex-col gap-6' : 'flex flex-col gap-6'}>{children}</div>
    </>
  );
}
