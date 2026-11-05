import { LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SessionsViewState } from '../../common/control-api.js';
import type { DaemonStatus } from '../../common/types.js';
import { sessionsState, type SessionsState } from '../lib/sessions.js';
import { Button } from '../ui/Button.js';
import { Notice } from '../ui/Notice.js';
import { Page } from './Page.js';

/**
 * The Sessões section while the PWA is on screen. The page itself draws nothing here: main places the sessions view (a
 * native view) over this area, using the rectangle the shell reports. What stays is the section's heading for screen readers
 * and for the keyboard focus, and the region the view sits in.
 */
export function SessionsStage() {
  const { t } = useTranslation();
  return (
    <>
      <h1 id="page-title" tabIndex={-1} className="sr-only outline-none">
        {t('sections.sessions.label')}
      </h1>
      <div role="region" aria-label={t('sessions.viewLabel')} data-slot="sessions-stage" className="h-full" />
    </>
  );
}

export interface SessionsUnavailableProps {
  daemon: DaemonStatus | null;
  /** What main says about the view; `crashed` is shown as an explanation of its own. */
  viewState?: SessionsViewState;
  onOpenOverview: () => void;
}

const TONES: Record<Exclude<SessionsState, 'ready'>, 'info' | 'attention' | 'destructive'> = {
  crashed: 'destructive',
  starting: 'info',
  stopped: 'info',
  error: 'destructive',
  restricted: 'attention',
};

/**
 * The daemon is not ready (starting, stopped, failed, or Tailscale-only), or the PWA page kept dying: the control center says
 * so instead of a blank area.
 */
export function SessionsUnavailable({ daemon, viewState = 'ok', onOpenOverview }: SessionsUnavailableProps) {
  const { t } = useTranslation();
  const state = sessionsState(daemon, viewState);
  if (state === 'ready') return null;
  const port = daemon?.port ?? 0;
  const message = daemon?.message ?? null;
  const title = t(`sessions.${state}Title`);
  // A message of main (why it failed, why it is Tailscale-only) is more exact than the generic line, and is already in this language.
  const detail = state === 'crashed' ? t('sessions.crashedDetail') : (message ?? (state === 'starting' ? t('sessions.startingDetail', { port }) : t(`sessions.${state}Detail`)));
  const logTail = daemon?.logTail ?? [];
  return (
    <Page section="sessions">
      <div data-slot="sessions-unavailable" data-state={state}>
        <Notice
          tone={TONES[state]}
          title={title}
          action={
            <Button icon={<LayoutDashboard aria-hidden="true" />} onClick={onOpenOverview}>
              {t('sessions.openOverview')}
            </Button>
          }
        >
          {detail}
          {state === 'error' && logTail.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-default text-foreground">{t('sessions.lastLines')}</summary>
              <pre className="selectable mt-1.5 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-foreground">
                {logTail.join('\n')}
              </pre>
            </details>
          ) : null}
        </Notice>
      </div>
    </Page>
  );
}
