import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Mic, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TranscriptionModelsResponse, TranscriptionProvider, TranscriptionSettingsResponse, UpdateTranscriptionSettings } from '@nanachi/shared';
import { createApiClient } from '../api.js';
import type { Machine } from '../machines.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, listRowClass, SectionHeading } from '../components/ListGroup.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const PROVIDERS = ['whisper', 'openai', 'groq', 'custom'] as const;
const DEFAULT_MODELS: Record<TranscriptionProvider, string> = {
  whisper: 'ggml-base-q5_1.bin', openai: 'gpt-transcribe', groq: 'whisper-large-v3-turbo', custom: '',
};
const selectClass = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring';

function Field({ label, children }: { label: string; children(id: string): ReactNode }) {
  const id = useId();
  return <li className={`${listRowClass} flex-col items-stretch gap-1.5`}><label htmlFor={id} className="text-sm font-medium">{label}</label>{children(id)}</li>;
}

export interface TranscriptionSettingsFormProps {
  settings: TranscriptionSettingsResponse;
  catalog: TranscriptionModelsResponse | null;
  modelsLoading: boolean;
  modelsFailed: boolean;
  onRefresh(): void;
  onSave(input: UpdateTranscriptionSettings): Promise<TranscriptionSettingsResponse>;
}

/** API keys live only in this mounted form and the authenticated save request. */
export function TranscriptionSettingsForm({ settings, catalog, modelsLoading, modelsFailed, onRefresh, onSave }: TranscriptionSettingsFormProps) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState('');
  const [removeApiKey, setRemoveApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const removeId = useId();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const remote = draft.provider !== 'whisper';
  const sameDestination = draft.provider === settings.provider && draft.baseUrl === settings.baseUrl;
  const configured = sameDestination && settings.apiKeyConfigured;
  const connectionDirty = !sameDestination || apiKey !== '' || removeApiKey;
  const dirty = draft.provider !== settings.provider || draft.model !== settings.model || draft.baseUrl !== settings.baseUrl || draft.timeoutMs !== settings.timeoutMs || apiKey !== '' || removeApiKey;
  const models = connectionDirty ? [] : (catalog?.models ?? []).filter((model) => model.provider === draft.provider);
  const patch = (next: Partial<TranscriptionSettingsResponse>) => { setDraft((previous) => ({ ...previous, ...next })); setSaved(false); };

  async function save() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setFailed(false); setSaved(false);
    try {
      const { apiKeyConfigured: _configured, ...input } = draft;
      const confirmed = await onSave({ ...input, ...(apiKey !== '' ? { apiKey } : {}), ...(removeApiKey ? { removeApiKey: true } : {}) });
      if (mounted.current) { setDraft(confirmed); setApiKey(''); setRemoveApiKey(false); setSaved(true); }
    } catch { if (mounted.current) setFailed(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  return <form data-slot="transcription-settings" className="flex min-w-0 flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <p className="text-sm text-muted-foreground">{t('transcription.description')}</p>
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
      <ListGroup>
        <Field label={t('transcription.provider')}>{(id) => <select id={id} data-slot="transcription-provider" className={selectClass} value={draft.provider} onChange={(event) => {
          const provider = PROVIDERS.find((value) => value === event.target.value);
          if (provider !== undefined) { patch({ provider, model: DEFAULT_MODELS[provider], baseUrl: '' }); setApiKey(''); setRemoveApiKey(false); }
        }}>{PROVIDERS.map((provider) => <option key={provider} value={provider}>{t(`transcription.providers.${provider}`)}</option>)}</select>}</Field>
        {draft.provider === 'custom' && <Field label={t('transcription.baseUrl')}>{(id) => <><Input id={id} data-slot="transcription-base-url" type="url" required autoComplete="off" spellCheck={false} value={draft.baseUrl} maxLength={2000} aria-describedby={`${id}-hint`} onChange={(event) => { patch({ baseUrl: event.target.value }); setApiKey(''); setRemoveApiKey(false); }} /><p id={`${id}-hint`} className="text-sm text-muted-foreground">{t('transcription.urlHint')}</p></>}</Field>}
        {remote && <Field label={t('transcription.apiKey')}>{(id) => <><Input id={id} data-slot="transcription-api-key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} maxLength={8000} required={draft.provider !== 'custom' && !configured} disabled={removeApiKey} aria-describedby={`${id}-hint`} onChange={(event) => { setApiKey(event.target.value); setSaved(false); }} /><p id={`${id}-hint`} className="text-sm text-muted-foreground">{t(configured ? 'transcription.keyConfigured' : 'transcription.keyEmpty')}</p></>}</Field>}
        {remote && configured && <li className={listRowClass}><label htmlFor={removeId} className="flex min-h-11 min-w-0 flex-1 items-center text-base">{t('transcription.removeKey')}</label><Switch id={removeId} checked={removeApiKey} onCheckedChange={(remove) => { setRemoveApiKey(remove); if (remove) setApiKey(''); setSaved(false); }} className="relative after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']" /></li>}
        <Field label={t('transcription.model')}>{(id) => <select id={id} data-slot="transcription-model" className={selectClass} required={draft.provider !== 'custom'} value={draft.model} disabled={draft.provider === 'whisper'} onChange={(event) => patch({ model: event.target.value })}>
          {draft.model === '' && <option value="">{t('transcription.chooseModel')}</option>}
          {draft.model !== '' && !models.some((model) => model.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.deprecated ? ` · ${t('transcription.deprecated')}` : ''}</option>)}
        </select>}</Field>
        {draft.provider === 'custom' && <Field label={t('transcription.modelId')}>{(id) => <><Input id={id} data-slot="transcription-model-id" autoComplete="off" spellCheck={false} pattern={'\\S+'} value={draft.model} maxLength={500} aria-describedby={`${id}-hint`} onChange={(event) => patch({ model: event.target.value })} /><p id={`${id}-hint`} className="text-sm text-muted-foreground">{t('transcription.manualHint')}</p></>}</Field>}
        <Field label={t('transcription.timeoutMs')}>{(id) => <Input id={id} data-slot="transcription-timeout" type="number" inputMode="numeric" required min={5000} max={180000} step={1} value={Number.isFinite(draft.timeoutMs) ? draft.timeoutMs : ''} onChange={(event) => patch({ timeoutMs: event.target.valueAsNumber })} />}</Field>
      </ListGroup>
      <p data-slot="transcription-privacy" className="text-sm text-muted-foreground">{t(remote ? 'transcription.remotePrivacy' : 'transcription.localPrivacy')}</p>
      {draft.provider === 'custom' && <p className="text-sm text-muted-foreground">{t('transcription.customHint')}</p>}
      {remote && <>
        <p className="text-sm text-muted-foreground">{t('transcription.readinessHint')}</p>
        {connectionDirty && <p className="text-sm text-muted-foreground">{t('transcription.saveBeforeModels')}</p>}
        <Button type="button" variant="secondary" data-slot="transcription-refresh-models" disabled={connectionDirty || modelsLoading} aria-busy={modelsLoading} onClick={onRefresh}><RefreshCw aria-hidden="true" className={`size-4 ${modelsLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} />{t('transcription.refreshModels')}</Button>
        {!connectionDirty && !modelsLoading && catalog !== null && models.length === 0 && <p className="text-sm text-muted-foreground">{t('transcription.noModels')}</p>}
        {!connectionDirty && modelsFailed && <ErrorNotice message={t('transcription.modelsFailed')} />}
      </>}
      <Button type="submit" data-slot="transcription-save" disabled={busy || (!dirty && !failed)}>{t(busy ? 'transcription.saving' : 'transcription.save')}</Button>
    </fieldset>
    {failed && <ErrorNotice message={t('transcription.saveFailed')} />}
    <p role="status" data-slot="transcription-save-status" className="text-sm text-muted-foreground">{saved && !dirty ? t('transcription.saved') : dirty ? t('transcription.unsaved') : null}</p>
  </form>;
}

export function TranscriptionSettings({ machine }: { machine: Machine }) {
  const { t } = useTranslation('settings');
  const heading = useId();
  const api = useMemo(() => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }), [machine.baseUrl, machine.token]);
  const [settings, setSettings] = useState<TranscriptionSettingsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [catalog, setCatalog] = useState<TranscriptionModelsResponse | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsFailed, setModelsFailed] = useState(false);
  const active = useRef(true);
  const generation = useRef(0);
  const modelsBusy = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current += 1; }; }, []);
  useEffect(() => {
    let current = true;
    setFailed(false);
    api.transcriptionSettings().then((next) => { if (current) setSettings(next); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [api, version]);

  async function refresh() {
    if (modelsBusy.current) return;
    const current = ++generation.current;
    modelsBusy.current = true; setModelsLoading(true); setModelsFailed(false);
    try { const next = await api.transcriptionModels(); if (active.current && current === generation.current) setCatalog(next); }
    catch { if (active.current && current === generation.current) setModelsFailed(true); }
    finally { if (current === generation.current) { modelsBusy.current = false; if (active.current) setModelsLoading(false); } }
  }

  useEffect(() => { if (settings !== null) void refresh(); }, [api, settings]);

  return <section data-slot="transcription-section" aria-labelledby={heading} className="flex min-w-0 flex-col gap-3">
    <SectionHeading icon={Mic} id={heading}>{t('transcription.title')}</SectionHeading>
    {settings === null && !failed && <p role="status" className="text-sm text-muted-foreground">{t('transcription.loading')}</p>}
    {failed && <ErrorNotice message={t('transcription.loadFailed')} action={{ label: t('transcription.retry'), onClick: () => setVersion((value) => value + 1) }} />}
    {settings !== null && <TranscriptionSettingsForm settings={settings} catalog={catalog} modelsLoading={modelsLoading} modelsFailed={modelsFailed} onRefresh={() => void refresh()} onSave={async (input) => {
      const confirmed = await api.setTranscriptionSettings(input);
      if (active.current) {
        generation.current += 1; modelsBusy.current = false;
        setCatalog(null); setModelsLoading(false); setModelsFailed(false); setSettings(confirmed);
      }
      return confirmed;
    }} />}
  </section>;
}
