import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { LearningNotice as Notice, MemoryEntry } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { MemoryEntries } from '../components/GlobalMemory.js';
import { Button } from '@/components/ui/button';

export function LearningNoticeView({ notice, api, onManage }: {
  notice: Notice;
  api: ApiClient;
  onManage?: ((reviewId: string, action: 'approve' | 'reject' | 'revert') => Promise<void>) | undefined;
}) {
  const { t } = useTranslation('learning');
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const lock = useRef(false);
  async function manage(action: 'approve' | 'reject' | 'revert') {
    if (onManage === undefined || lock.current) return;
    lock.current = true; setBusy(true); setFailed(false);
    try { await onManage(notice.reviewId, action); setEntries(null); }
    catch { setFailed(true); }
    finally { lock.current = false; setBusy(false); }
  }
  async function inspect() {
    setLoading(true); setLoadFailed(false);
    try { setEntries(await Promise.all(notice.entryIds.map((entryId) => api.readMemory(entryId)))); }
    catch { setLoadFailed(true); }
    finally { setLoading(false); }
  }
  const actionable = onManage !== undefined && (notice.status === 'pending' || notice.status === 'applied');
  return <details data-slot="learning-notice" data-review-id={notice.reviewId} data-status={notice.status} className="group min-w-0 text-xs text-muted-foreground">
    <summary aria-controls={id} className="flex min-h-11 min-w-0 items-center gap-1.5 list-none [&::-webkit-details-marker]:hidden">
      <span className="min-w-0 [overflow-wrap:anywhere]">{t(`notice.${notice.status}`)}{(notice.status === 'pending' || notice.status === 'applied') && <> · {t('notice.counts', { memories: t('notice.memories', { count: notice.memoryCount }), skills: t('notice.skills', { count: notice.skillCount }) })}</>}</span>
      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 group-open:rotate-180" />
    </summary>
    <div id={id} className="flex min-w-0 flex-col gap-2 pb-2 text-sm">
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{notice.summary}</p>
      {notice.status === 'failed' && <p>{t('notice.failedHint')}</p>}
      {actionable && <div className="flex flex-wrap gap-2">
        {notice.status === 'pending' ? <><Button variant="ghost" className="h-auto min-h-11 whitespace-normal text-sm" data-slot="learning-approve" disabled={busy} onClick={() => void manage('approve')}>{t('approve')}</Button><Button variant="ghost" className="h-auto min-h-11 whitespace-normal text-sm" data-slot="learning-reject" disabled={busy} onClick={() => void manage('reject')}>{t('reject')}</Button></> : <Button variant="ghost" className="h-auto min-h-11 whitespace-normal text-sm" data-slot="learning-revert" disabled={busy} onClick={() => void manage('revert')}>{t('revert')}</Button>}
      </div>}
      {notice.entryIds.length > 0 && <Button variant="ghost" className="h-auto min-h-11 self-start whitespace-normal text-sm" data-slot="learning-inspect" disabled={loading} onClick={() => void inspect()}>{t('notice.entries')}</Button>}
      {busy && <p role="status">{t('saving')}</p>}
      {failed && <p role="alert">{t('notice.actionFailed')}</p>}
      {loadFailed && <p role="alert">{t('memoryFailed')}</p>}
      {entries !== null && <MemoryEntries entries={entries} api={api} onChanged={inspect} />}
    </div>
  </details>;
}
