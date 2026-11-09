import { useEffect, useId, useRef, useState } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MemoryEntry, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listRowClass, SectionHeading } from './ListGroup.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const controlClass = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring';

export function MemoryEntryRow({ entry, api, onChanged }: { entry: MemoryEntry; api: ApiClient; onChanged(): Promise<void> }) {
  const { t } = useTranslation('learning');
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [content, setContent] = useState(entry.content);
  const [forgetting, setForgetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const lock = useRef(false);
  async function change(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setFailed(false);
    try { await action(); setEditing(false); setForgetting(false); await onChanged(); }
    catch { setFailed(true); }
    finally { lock.current = false; setBusy(false); }
  }
  return <li data-slot="memory-entry" data-entry-id={entry.id} data-status={entry.status} className="min-w-0 px-4 py-1">
    <details><summary className="flex min-h-14 min-w-0 flex-col justify-center gap-0.5 py-2 [overflow-wrap:anywhere]"><span>{entry.title}</span><span className="text-sm text-muted-foreground">{t(entry.kind)} · {t(entry.status === 'pending' ? 'pending' : 'active')}</span></summary>
      <div className="flex min-w-0 flex-col gap-3 pb-3">
        {editing ? <form className="flex min-w-0 flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void change(() => api.saveMemory(entry.workspaceId, { id: entry.id, expectedVersion: entry.version, kind: entry.kind, title, content, evidenceSeqs: entry.evidenceSeqs })); }}>
          <label htmlFor={`${id}-title`} className="text-sm font-medium">{t('title')}</label><Input id={`${id}-title`} data-slot="memory-title" value={title} required maxLength={160} disabled={busy} onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor={`${id}-content`} className="text-sm font-medium">{t('content')}</label><textarea id={`${id}-content`} data-slot="memory-content" className={`${controlClass} min-h-40 py-2 [overflow-wrap:anywhere]`} value={content} required maxLength={12000} disabled={busy} onChange={(event) => setContent(event.target.value)} />
          <div className="flex flex-wrap gap-2"><Button type="submit" data-slot="memory-save" disabled={busy}>{t(busy ? 'saving' : 'saveMemory')}</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{t('cancel')}</Button></div>
        </form> : <p data-slot="memory-entry-content" className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{entry.content}</p>}
        {!editing && !forgetting && <div className="flex flex-wrap gap-2">
          {entry.status === 'active' && <><Button variant="secondary" data-slot="memory-edit" disabled={busy} onClick={() => { setTitle(entry.title); setContent(entry.content); setEditing(true); }}>{t('edit')}</Button><Button variant="destructive-ghost" data-slot="memory-forget" disabled={busy} onClick={() => setForgetting(true)}>{t('forget')}</Button></>}
          {entry.status === 'pending' && entry.reviewId !== null && <><Button data-slot="learning-approve" disabled={busy} onClick={() => void change(() => api.manageLearningReview(entry.workspaceId, entry.reviewId!, 'approve'))}>{t('approve')}</Button><Button variant="ghost" data-slot="learning-reject" disabled={busy} onClick={() => void change(() => api.rejectLearningReview(entry.workspaceId, entry.reviewId!))}>{t('reject')}</Button></>}
        </div>}
        {forgetting && <div className="flex flex-col gap-2"><p className="font-medium">{t('confirmForget')}</p><p className="text-sm text-muted-foreground">{t('forgetHint')}</p><div className="flex flex-wrap gap-2"><Button variant="ghost" disabled={busy} onClick={() => setForgetting(false)}>{t('cancel')}</Button><Button variant="destructive" data-slot="memory-confirm-forget" disabled={busy} onClick={() => void change(() => api.forgetMemory(entry.workspaceId, entry.id, entry.version))}>{t('forget')}</Button></div></div>}
        {failed && <ErrorNotice message={t('writeFailed')} />}
      </div>
    </details>
  </li>;
}

export function MemoryEntries({ entries, api, onChanged }: { entries: readonly MemoryEntry[]; api: ApiClient; onChanged(): Promise<void> }) {
  const { t } = useTranslation('learning');
  return entries.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : <ListGroup>{entries.map((entry) => <MemoryEntryRow key={`${entry.id}-${entry.version}`} entry={entry} api={api} onChanged={onChanged} />)}</ListGroup>;
}

export function WorkspaceMemory({ api }: { api: ApiClient }) {
  const { t } = useTranslation('learning');
  const id = useId();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'' | MemoryEntry['kind']>('');
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState(false);
  const [workspaceFailure, setWorkspaceFailure] = useState(false);
  const [version, setVersion] = useState(0);
  const generation = useRef(0);
  const scope = useRef(workspaceId);
  scope.current = workspaceId;
  useEffect(() => {
    let active = true;
    setWorkspaceFailure(false);
    api.listWorkspaces().then((list) => { if (active) setWorkspaces(list); }, () => { if (active) setWorkspaceFailure(true); });
    return () => { active = false; };
  }, [api, version]);
  useEffect(() => {
    setEntries(null); setFailure(false);
    if (workspaceId === '') return;
    void load('');
    return () => { generation.current += 1; };
  }, [api, workspaceId]);
  async function load(search = query) {
    if (workspaceId === '' || scope.current !== workspaceId) return;
    const current = ++generation.current;
    setLoading(true); setFailure(false);
    try { const list = await api.listMemories(workspaceId, { query: search, ...(kind === '' ? {} : { kind }) }); if (current === generation.current) setEntries(list); }
    catch { if (current === generation.current) setFailure(true); }
    finally { if (current === generation.current) setLoading(false); }
  }
  return <section data-slot="workspace-memory" aria-labelledby={`${id}-heading`} className="mt-2 flex min-w-0 flex-col gap-3">
    <SectionHeading icon={Database} id={`${id}-heading`}>{t('memoryHeading')}</SectionHeading>
    <p className="text-sm text-muted-foreground">{t('scope')}</p>
    {workspaceFailure && <ErrorNotice message={t('memoryFailed')} action={{ label: t('retry'), onClick: () => setVersion((value) => value + 1) }} />}
    {workspaces === null && !workspaceFailure && <p role="status" className="text-sm text-muted-foreground">{t('loadingMemory')}</p>}
    {workspaces !== null && workspaces.length === 0 && <p className="text-sm text-muted-foreground">{t('noWorkspaces')}</p>}
    {workspaces !== null && workspaces.length > 0 && <ListGroup><li className={`${listRowClass} flex-col items-stretch gap-1.5`}><label htmlFor={`${id}-workspace`} className="text-sm font-medium">{t('workspace')}</label><select id={`${id}-workspace`} data-slot="memory-workspace" className={controlClass} value={workspaceId} onChange={(event) => { generation.current += 1; setEntries(null); setQuery(''); setWorkspaceId(event.target.value); }}><option value="">{t('chooseWorkspace')}</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.path}</option>)}</select></li></ListGroup>}
    {workspaceId !== '' && <>
      <form className="flex min-w-0 flex-col gap-2" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label htmlFor={`${id}-query`} className="text-sm font-medium">{t('query')}</label><Input id={`${id}-query`} data-slot="memory-query" type="search" value={query} maxLength={1000} onChange={(event) => setQuery(event.target.value)} />
        <label htmlFor={`${id}-kind`} className="text-sm font-medium">{t('kind')}</label><select id={`${id}-kind`} data-slot="memory-kind" className={controlClass} value={kind} onChange={(event) => { const value = event.target.value; if (value === '' || value === 'memory' || value === 'skill') setKind(value); }}><option value="">{t('allKinds')}</option><option value="memory">{t('memory')}</option><option value="skill">{t('skill')}</option></select>
        <div className="flex flex-wrap gap-2"><Button type="submit" variant="secondary" data-slot="memory-search" disabled={loading}>{t('search')}</Button><Button type="button" variant="ghost" data-slot="memory-reload" disabled={loading} onClick={() => void load()}><RefreshCw className="size-4" aria-hidden="true" />{t('reload')}</Button></div>
      </form>
      {loading && <p role="status" className="text-sm text-muted-foreground">{t('loadingMemory')}</p>}
      {failure && <ErrorNotice message={t('memoryFailed')} action={{ label: t('retry'), onClick: () => void load() }} />}
      {entries !== null && <MemoryEntries entries={entries} api={api} onChanged={() => load()} />}
    </>}
  </section>;
}
