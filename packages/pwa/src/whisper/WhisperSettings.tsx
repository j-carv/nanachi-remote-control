import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Download, Mic, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createApiClient } from '../api.js';
import { ListGroup, listRowClass, SectionHeading } from '../components/ListGroup.js';
import type { Machine } from '../machines.js';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Switch } from '@/components/ui/switch';
import { useWhisperStatus } from './useWhisperStatus.js';

export function WhisperSettings({ machine }: { machine: Machine }) {
  const { t } = useTranslation('settings');
  const id = useId();
  const { baseUrl, token } = machine;
  const api = useMemo(() => createApiClient({ baseUrl, token }), [baseUrl, token]);
  const [quick, setQuick] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const { status, setStatus, unreachable } = useWhisperStatus(api, !submitting, quick);
  const state = status?.state;
  const ready = state === 'ready';
  const transitioning = state === 'installing' || state === 'removing';
  const progress = !unreachable && status?.state === 'installing' ? status.progress : undefined;
  const description = unreachable ? t('whisper.unreachable') : t(`whisper.${state ?? 'loading'}`);
  const verifying = progress === 100;
  const PhaseIcon = verifying ? ShieldCheck : Download;

  async function change(next: boolean) {
    if (pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      const result = await (next ? api.installWhisper() : api.removeWhisper());
      setStatus(result);
      setConfirm(false);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  // Poll quickly on the Settings screen only while the daemon has a job in progress.
  useEffect(() => setQuick(transitioning), [transitioning]);

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-2">
      <SectionHeading icon={Mic} id={`${id}-heading`}>{t('whisper.title')}</SectionHeading>
      <ListGroup>
        <li className={listRowClass}>
          <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base">{t('whisper.machine', { name: machine.name })}</span>
            {progress === undefined && <span className="text-sm text-muted-foreground" role="status">{description}</span>}
          </label>
          {state === 'install_failed' || state === 'remove_failed' ? (
            <Button size="compact" variant="secondary" disabled={submitting || unreachable}
              onClick={() => state === 'remove_failed' ? setConfirm(true) : void change(true)}>
              {t('whisper.retry')}
            </Button>
          ) : (
            <Switch id={id} checked={ready || state === 'installing'} aria-label={t('whisper.title')}
              disabled={submitting || unreachable || transitioning || state === undefined || state === 'unsupported'}
              onCheckedChange={(next) => next ? void change(true) : setConfirm(true)} />
          )}
        </li>
        {progress !== undefined && (
          <li data-slot="whisper-install-progress" className="flex flex-col gap-2 px-4 py-3 motion-safe:animate-enter">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium" role="status">
                <PhaseIcon className="size-4 shrink-0 text-running" aria-hidden="true" />
                {t(verifying ? 'whisper.verifying' : 'whisper.installing')}
              </span>
              <span className="shrink-0 text-sm font-semibold tabular-nums" aria-hidden="true">{Math.floor(progress)}%</span>
            </div>
            <div role="progressbar" aria-label={t('whisper.title')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
              className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full origin-left rounded-full bg-running transition-transform duration-500 ease-out-premium motion-reduce:transition-none"
                style={{ transform: `scaleX(${progress / 100})` }} />
            </div>
          </li>
        )}
      </ListGroup>
      {failed && !confirm && <p className="text-sm text-destructive" role="alert">{t('whisper.requestFailed')}</p>}
      {confirm && (
        <Drawer open dismissible={!submitting} onOpenChange={(open) => { if (!open && !submitting) setConfirm(false); }}>
          <DrawerContent size="sm">
            <DrawerHeader>
              <DrawerTitle>{t('whisper.confirmTitle')}</DrawerTitle>
              <DrawerDescription>{t('whisper.confirmDescription')}</DrawerDescription>
            </DrawerHeader>
            {failed && <p className="px-5 text-sm text-destructive" role="alert">{t('whisper.requestFailed')}</p>}
            <DrawerFooter className="flex-row wide:justify-end">
              <Button variant="secondary" size="compact" disabled={submitting} onClick={() => setConfirm(false)}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
              <Button variant="destructive" size="compact" disabled={submitting} onClick={() => void change(false)}>
                {t('whisper.confirmAction')}
              </Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      )}
    </section>
  );
}
