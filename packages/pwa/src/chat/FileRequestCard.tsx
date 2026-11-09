import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileUp, LoaderCircle } from 'lucide-react';
import { fileMatchesAccept, type FileInfo, type RequestFileResult } from '@nanachi/shared';
import { ApiError, type ApiClient } from '../api.js';
import { FileAttachment } from '../components/FileAttachment.js';
import { Button } from '@/components/ui/button';
import type { FileRequestItem } from './reducer.js';

export type FileRequestCardState = 'idle' | 'uploading' | 'saving' | 'upload_failed' | 'response_failed' | 'invalid_type' | 'unavailable';

interface FileRequestCardViewProps {
  api: ApiClient;
  request: FileRequestItem;
  state: FileRequestCardState;
  selectedName?: string | undefined;
  progress?: number;
  expired?: boolean;
  cancelling?: boolean;
  onChoose?: (file: File) => void;
  onSend?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
}

/** Agent prompts and file names are plain text, including in read-only history. */
export function FileRequestCardView({ api, request, state, selectedName, progress = 0, expired = Date.now() >= request.expiresAt, cancelling = false, onChoose, onSend, onCancel, onRetry }: FileRequestCardViewProps) {
  const { t } = useTranslation('chat');
  const headingId = useId();
  const hintId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const unavailable = request.unavailable || state === 'unavailable' || onChoose === undefined;
  const actionable = request.result === null && !unavailable && !expired;
  const busy = state === 'uploading' || state === 'saving';
  const uncertain = state === 'response_failed';
  return (
    <section data-slot="file-request-card" data-state={request.result?.status ?? (expired ? 'expired' : unavailable ? 'unavailable' : state)} aria-labelledby={headingId} aria-busy={busy && actionable} className="flex min-w-0 max-w-full flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-2.5">
        <FileUp className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 id={headingId} className="min-w-0 text-base leading-snug font-semibold whitespace-pre-wrap [overflow-wrap:anywhere]">{request.prompt}</h2>
      </div>
      {request.accept !== undefined && <p id={hintId} className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{t('fileRequest.accept', { types: request.accept.join(', ') })}</p>}
      {actionable ? <>
        <p className="text-sm text-muted-foreground">{t('fileRequest.hint')}</p>
        <input ref={picker} type="file" className="hidden" accept={request.accept?.join(',')} aria-label={t('fileRequest.choose')} aria-describedby={request.accept === undefined ? undefined : hintId} onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file !== undefined) onChoose?.(file);
        }} />
        {selectedName !== undefined && <p className="text-sm font-medium [overflow-wrap:anywhere]">{t('fileRequest.selected', { name: selectedName })}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11 max-w-full whitespace-normal" disabled={busy || uncertain} onClick={() => picker.current?.click()}>{t('fileRequest.choose')}</Button>
          <Button type="button" className="min-h-11" disabled={busy || uncertain || selectedName === undefined || state === 'invalid_type'} onClick={onSend}>{t('fileRequest.send')}</Button>
          <Button type="button" variant="ghost" className="min-h-11" disabled={busy || uncertain} onClick={onCancel}>{t('fileRequest.cancel')}</Button>
        </div>
        {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />{state === 'uploading' ? t('fileRequest.uploading', { percent: Math.round(progress * 100) }) : t('fileRequest.saving')}</p>}
        {state === 'invalid_type' && <p role="alert" className="text-sm text-destructive">{t('fileRequest.invalidType')}</p>}
        {(state === 'upload_failed' || uncertain) && <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">{t(uncertain ? 'fileRequest.responseFailed' : 'fileRequest.uploadFailed')}</p>
          {uncertain && <p className="text-sm [overflow-wrap:anywhere]">{cancelling ? t('fileRequest.unconfirmedCancel') : t('fileRequest.unconfirmed', { name: selectedName })}</p>}
          <Button type="button" variant="outline" className="min-h-11" onClick={onRetry}>{t('fileRequest.retry')}</Button>
        </div>}
      </> : <>
        {request.result?.status === 'received' && <FileAttachment api={api} file={request.result.file} />}
        <p role="status" className="text-sm text-muted-foreground">{request.result?.status === 'received' ? t('fileRequest.received') : request.result?.status === 'cancelled' ? t(`fileRequest.cancelled.${request.result.reason}`) : expired ? t('fileRequest.cancelled.expired') : t('fileRequest.unavailable')}</p>
      </>}
    </section>
  );
}

interface FileRequestCardProps {
  api: ApiClient;
  request: FileRequestItem;
  onUpload(file: File, onProgress: (fraction: number) => void): Promise<FileInfo>;
  onRespond(fileId: string | null): Promise<RequestFileResult>;
}

/** Uploading alone never answers. An uncertain reply retries the exact uploaded ID, not the upload. */
export function FileRequestCard({ api, request, onUpload, onRespond }: FileRequestCardProps) {
  const [state, setState] = useState<FileRequestCardState>('idle');
  const [selected, setSelected] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [expired, setExpired] = useState(() => Date.now() >= request.expiresAt);
  const [confirmed, setConfirmed] = useState<RequestFileResult | null>(null);
  const uploaded = useRef<FileInfo | null>(null);
  const decision = useRef<string | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const update = () => setExpired(Date.now() >= request.expiresAt);
    update();
    const timer = window.setTimeout(update, Math.max(0, request.expiresAt - Date.now()));
    document.addEventListener('visibilitychange', update);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', update); };
  }, [request.expiresAt]);

  async function submit(cancel: boolean, retry = false) {
    if (busy.current || request.unavailable || request.result !== null || confirmed !== null || Date.now() >= request.expiresAt) return;
    if (!retry && !cancel && selected === null) return;
    if (!cancel && selected !== null && !fileMatchesAccept({ name: selected.name, mime: selected.type }, request.accept)) {
      setState('invalid_type');
      return;
    }
    busy.current = true;
    let replying = retry && state === 'response_failed';
    try {
      if (!replying) {
        if (!cancel && uploaded.current === null && selected !== null) {
          setState('uploading');
          setProgress(0);
          uploaded.current = await onUpload(selected, setProgress);
        }
        if (Date.now() >= request.expiresAt) { setExpired(true); return; }
        const file = uploaded.current;
        if (!cancel && file === null) return;
        decision.current = cancel || file === null ? null : file.fileId;
      }
      replying = true;
      setState('saving');
      setConfirmed(await onRespond(decision.current));
    } catch (error: unknown) {
      const unavailable = error instanceof ApiError && error.status !== null && [401, 403, 404, 409, 410].includes(error.status);
      setState(unavailable ? 'unavailable' : replying ? 'response_failed' : 'upload_failed');
    } finally {
      busy.current = false;
    }
  }

  return <FileRequestCardView api={api} request={confirmed === null ? request : { ...request, result: confirmed }} state={state} selectedName={selected?.name} progress={progress} expired={expired} cancelling={decision.current === null}
    onChoose={(file) => {
      if (busy.current || state === 'response_failed') return;
      uploaded.current = null;
      setSelected(file);
      setState(fileMatchesAccept({ name: file.name, mime: file.type }, request.accept) ? 'idle' : 'invalid_type');
    }}
    onSend={() => void submit(false)} onCancel={() => void submit(true)} onRetry={() => void submit(decision.current === null && state === 'response_failed', true)} />;
}
