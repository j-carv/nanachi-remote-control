import type { WhisperStatus } from '@nanachi/shared';
import { Download, Mic, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../state/api.js';
import { Button } from '../ui/Button.js';
import { Dialog } from '../ui/Dialog.js';
import { Group, Row, SectionHeading } from '../ui/Surface.js';
import { Switch } from '../ui/Switch.js';

export function WhisperSettings() {
  const { t } = useTranslation();
  const { settings } = useApi();
  const [status, setStatus] = useState<WhisperStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const state = status?.state;
  const transitioning = state === 'installing' || state === 'removing';
  const progress = !unreachable && status?.state === 'installing' ? status.progress : undefined;
  const verifying = progress === 100;
  const PhaseIcon = verifying ? ShieldCheck : Download;

  useEffect(() => {
    if (submitting) return;
    let active = true;
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      try {
        const result = await settings.whisper('status');
        if (!active) return;
        if (result.ok) setStatus(result.value);
        setUnreachable(!result.ok);
      } catch {
        if (active) setUnreachable(true);
      } finally {
        fetching = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), transitioning ? 1_000 : 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [settings, submitting, transitioning]);

  async function change(action: 'install' | 'remove') {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      const result = await settings.whisper(action);
      if (!result.ok) {
        setFailed(true);
        return;
      }
      setStatus(result.value);
      setConfirm(false);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="settings-whisper">
      <SectionHeading id="settings-whisper">{t('settings.whisper.title')}</SectionHeading>
      <Group>
        <Row
          icon={Mic}
          id="settings-whisper-toggle"
          title={t('settings.whisper.title')}
          description={progress === undefined && (
            <span role="status">
              {t(`settings.whisper.${unreachable ? 'unreachable' : state ?? 'loading'}`)}
            </span>
          )}
          trailing={state === 'install_failed' || state === 'remove_failed' ? (
            <Button disabled={submitting || unreachable}
              onClick={() => state === 'remove_failed' ? setConfirm(true) : void change('install')}>
              {t('settings.whisper.retry')}
            </Button>
          ) : (
            <Switch
              checked={state === 'ready' || state === 'installing'}
              disabled={submitting || unreachable || transitioning || state === undefined || state === 'unsupported'}
              labelledBy="settings-whisper-toggle"
              onCheckedChange={(next) => next ? void change('install') : setConfirm(true)}
            />
          )}
        />
        {progress !== undefined && (
          <div data-slot="whisper-install-progress" className="animate-row flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium" role="status">
                <PhaseIcon className="size-4 shrink-0 text-running" aria-hidden="true" />
                {t(verifying ? 'settings.whisper.verifying' : 'settings.whisper.installing')}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums" aria-hidden="true">{Math.floor(progress)}%</span>
            </div>
            <div role="progressbar" aria-label={t('settings.whisper.title')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
              className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full origin-left rounded-full bg-running transition-transform duration-500 ease-[var(--ease-premium)]"
                style={{ transform: `scaleX(${progress / 100})` }} />
            </div>
          </div>
        )}
      </Group>
      {failed && !confirm && <p role="alert" className="mt-2 text-sm text-destructive">{t('settings.whisper.requestFailed')}</p>}
      <Dialog
        open={confirm}
        dismissible={!submitting}
        onClose={() => { if (!submitting) setConfirm(false); }}
        title={t('settings.whisper.confirmTitle')}
        description={t('settings.whisper.confirmDescription')}
        footer={
          <>
            <Button disabled={submitting} onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" loading={submitting} onClick={() => void change('remove')}>
              {t('settings.whisper.confirmAction')}
            </Button>
          </>
        }
      >
        {failed && <p role="alert" className="text-sm text-destructive">{t('settings.whisper.requestFailed')}</p>}
      </Dialog>
    </section>
  );
}
