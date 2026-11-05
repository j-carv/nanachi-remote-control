import { useRef, useState } from 'react';
import { RefreshCcwDot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { appBuildId } from './buildInfo.js';
import { ForceUpdateError, runForceUpdate, type ForceUpdatePhase } from './forceUpdate.js';
import { browserForceUpdateEnv } from './forceUpdateBrowser.js';

/** "Forçar atualização" button on the machines home, and its confirmation drawer. The drawer does not close while the update runs. */
export function ForceUpdateAction({ className }: { className?: string | undefined } = {}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ForceUpdatePhase | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const running = useRef(false);
  const busy = phase !== null;

  async function start() {
    if (running.current) return;
    running.current = true;
    setFailure(null);
    setPhase('checking');
    try {
      // On success the page reloads and this screen goes away; the busy state stays until then.
      await runForceUpdate(browserForceUpdateEnv(), setPhase);
    } catch (error) {
      running.current = false;
      setPhase(null);
      setFailure(error instanceof ForceUpdateError ? error.message : t('forceUpdate.unexpected'));
    }
  }

  return (
    <>
      <Button variant="ghost" size="icon" className={className} aria-label={t('forceUpdate.button')} onClick={() => setOpen(true)}>
        <RefreshCcwDot aria-hidden="true" />
      </Button>
      <Drawer
        open={open}
        dismissible={!busy}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle>{t('forceUpdate.title')}</DrawerTitle>
            <DrawerDescription className="text-base leading-6 text-foreground/80">
              {t('forceUpdate.description')}
            </DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-3 px-5 pt-4">
            <p className="text-sm text-muted-foreground">{t('forceUpdate.version', { id: appBuildId() })}</p>
            {phase !== null && (
              <p role="status" aria-live="polite" className="text-sm font-medium">
                {t(`forceUpdate.phase.${phase}`)}
              </p>
            )}
            {failure !== null && <ErrorNotice message={t('forceUpdate.failed', { reason: failure })} />}
          </div>
          <DrawerFooter>
            <Button size="wide" onClick={() => void start()} disabled={busy}>
              {failure === null ? t('forceUpdate.start') : t('forceUpdate.retry')}
            </Button>
            <Button variant="secondary" size="wide" onClick={() => setOpen(false)} disabled={busy}>
              {t('actions.cancel')}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </>
  );
}
