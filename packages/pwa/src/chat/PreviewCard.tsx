import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Monitor } from 'lucide-react';
import { PREVIEW_HTTPS_PORT, previewLocalPort, type PreviewOpenResponse } from '@nanachi/shared';
import { ApiError } from '../api.js';
import { Button } from '@/components/ui/button';
import type { PreviewItem } from './reducer.js';

export type PreviewCardState = 'idle' | 'opening' | 'closing' | 'opened' | 'open_failed' | 'close_failed' | 'popup_blocked' | 'unavailable';

/** Only the isolated gateway may receive the single-use bootstrap ticket. */
export function validatedPreviewUrl(value: string, apiBaseUrl: string): string | null {
  try {
    const url = new URL(value);
    const api = new URL(apiBaseUrl);
    if (url.username !== '' || url.password !== '' || url.origin === api.origin) return null;
    const apiLocal = api.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname);
    const localHost = api.hostname === '[::1]' ? '127.0.0.1' : api.hostname;
    const local = apiLocal && url.protocol === 'http:' && url.hostname === localHost
      && Number(url.port || 80) === previewLocalPort(Number(api.port || 80));
    const tailnet = api.protocol === 'https:' && api.hostname.endsWith('.ts.net')
      && url.protocol === 'https:' && url.hostname === api.hostname && url.port === String(PREVIEW_HTTPS_PORT);
    return local || tailnet ? url.href : null;
  } catch { return null; }
}

interface PreviewCardViewProps {
  preview: PreviewItem;
  state: PreviewCardState;
  expired?: boolean;
  onOpen?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
}

export function PreviewCardView({ preview, state, expired = false, onOpen, onClose }: PreviewCardViewProps) {
  const { t } = useTranslation('chat');
  const headingId = useId();
  const unavailable = preview.unavailable || state === 'unavailable' || onOpen === undefined;
  const actionable = preview.closedReason === null && !expired && !unavailable;
  const busy = state === 'opening' || state === 'closing';
  return (
    <section data-slot="preview-card" data-state={preview.closedReason ?? (expired ? 'expired' : unavailable ? 'unavailable' : state)} aria-labelledby={headingId} aria-busy={busy && actionable} className="flex min-w-0 max-w-full flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-2.5">
        <Monitor className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 id={headingId} className="min-w-0 text-base leading-snug font-semibold whitespace-pre-wrap [overflow-wrap:anywhere]">{preview.title || t('preview.label')}</h2>
      </div>
      <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{t('preview.target', { port: preview.port, path: preview.path })}</p>
      {actionable ? <>
        <p className="text-sm text-muted-foreground">{t('preview.hint')}</p>
        <p className="text-sm text-muted-foreground">{t('preview.singleActive')}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="min-h-11 max-w-full whitespace-normal" disabled={busy} onClick={onOpen}><ExternalLink aria-hidden="true" />{t(state === 'opening' ? 'preview.opening' : 'preview.open')}</Button>
          <Button type="button" variant="outline" className="min-h-11 max-w-full whitespace-normal" disabled={busy} onClick={onClose}>{t(state === 'closing' ? 'preview.closing' : 'preview.close')}</Button>
        </div>
        {state === 'opened' && <p role="status" className="text-sm text-muted-foreground">{t('preview.opened')}</p>}
        {state === 'opening' && <p role="status" className="text-sm text-muted-foreground">{t('preview.connecting')}</p>}
        {(state === 'open_failed' || state === 'close_failed' || state === 'popup_blocked') && <p role="alert" className="text-sm text-destructive">{t(`preview.${state}`)}</p>}
      </> : <p role="status" className="text-sm text-muted-foreground">{t(preview.closedReason !== null ? `preview.closed.${preview.closedReason}` : expired ? 'preview.closed.expired' : 'preview.unavailable')}</p>}
    </section>
  );
}

interface PreviewCardProps {
  preview: PreviewItem;
  apiBaseUrl: string;
  onOpen?: (() => Promise<PreviewOpenResponse>) | undefined;
  onClose?: (() => Promise<void>) | undefined;
}

export function PreviewCard({ preview, apiBaseUrl, onOpen, onClose }: PreviewCardProps) {
  const [state, setState] = useState<PreviewCardState>('idle');
  const [expired, setExpired] = useState(() => Date.now() >= preview.expiresAt);
  const busy = useRef(false);
  const reservation = useRef<Window | null>(null);
  const current = useRef(preview);
  current.current = preview;
  useEffect(() => {
    const update = () => setExpired(Date.now() >= preview.expiresAt);
    update();
    const timer = window.setTimeout(update, Math.max(0, preview.expiresAt - Date.now()));
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
      reservation.current?.close();
      reservation.current = null;
    };
  }, [preview.expiresAt]);

  async function open() {
    if (busy.current || onOpen === undefined || current.current.unavailable || current.current.closedReason !== null || Date.now() >= preview.expiresAt) return;
    // Reserve synchronously in the click gesture. The ticket never enters React state, storage or chat links.
    const tab = window.open('', '_blank');
    if (tab === null) { setState('popup_blocked'); return; }
    tab.opener = null;
    const policy = tab.document.createElement('meta');
    policy.name = 'referrer';
    policy.content = 'no-referrer';
    tab.document.head.append(policy);
    reservation.current = tab;
    busy.current = true;
    setState('opening');
    try {
      const response = await onOpen();
      const url = validatedPreviewUrl(response.url, apiBaseUrl);
      if (reservation.current !== tab || tab.closed) { setState('idle'); return; }
      if (url === null || response.expiresAt <= Date.now()) throw new Error('Invalid preview gateway');
      if (current.current.unavailable || current.current.closedReason !== null || Date.now() >= preview.expiresAt) { tab.close(); return; }
      tab.location.replace(url);
      reservation.current = null;
      setState('opened');
    } catch (error: unknown) {
      tab.close();
      const unavailable = error instanceof ApiError && error.status !== null && [401, 403, 404, 409, 410].includes(error.status);
      setState(unavailable ? 'unavailable' : 'open_failed');
    } finally {
      if (reservation.current === tab) reservation.current = null;
      busy.current = false;
    }
  }

  async function close() {
    if (busy.current || onClose === undefined) return;
    busy.current = true;
    setState('closing');
    try {
      await onClose();
    } catch (error: unknown) {
      const unavailable = error instanceof ApiError && error.status !== null && [401, 403, 404, 409, 410].includes(error.status);
      setState(unavailable ? 'unavailable' : 'close_failed');
    } finally { busy.current = false; }
  }

  return <PreviewCardView preview={preview} state={state} expired={expired} onOpen={onOpen === undefined ? undefined : () => void open()} onClose={onClose === undefined ? undefined : () => void close()} />;
}
