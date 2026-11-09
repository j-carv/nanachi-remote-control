import type { TranscriptionModel, TranscriptionModelsResponse, TranscriptionProvider, TranscriptionSettings as Settings, TranscriptionSettingsResponse, TranscriptionStatus } from '@nanachi/shared';
import { Mic, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApi } from '../state/api.js';
import { Button } from '../ui/Button.js';
import { Group, Row, SectionHeading } from '../ui/Surface.js';
import { Switch } from '../ui/Switch.js';

const PROVIDERS: TranscriptionProvider[] = ['whisper', 'openai', 'groq', 'custom'];
const DEFAULT_MODELS: Record<TranscriptionProvider, string> = {
  whisper: 'ggml-base-q5_1.bin', openai: 'gpt-transcribe', groq: 'whisper-large-v3-turbo', custom: '',
};
const CONTROL = 'h-8 min-w-0 max-w-full rounded-md border border-input bg-card px-2 text-sm disabled:opacity-60';

export function TranscriptionSettings() {
  const { t } = useTranslation();
  const { settings: api } = useApi();
  const [saved, setSaved] = useState<TranscriptionSettingsResponse | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [status, setStatus] = useState<TranscriptionStatus | null>(null);
  const [catalog, setCatalog] = useState<TranscriptionModelsResponse | null>(null);
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(false);
  const catalogRequest = useRef(0);
  const statusRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; catalogRequest.current++; statusRequest.current++; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void api.transcriptionSettings().then((result) => {
      if (!active) return;
      if (!result.ok) { setFailed(true); return; }
      setSaved(result.value);
      const { apiKeyConfigured: _configured, ...value } = result.value;
      setDraft(value);
      setKey('');
      setRemoveKey(false);
    }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, reload]);

  useEffect(() => {
    let active = true;
    let fetching = false;
    async function refresh() {
      if (fetching || pending.current) return;
      fetching = true;
      const request = ++statusRequest.current;
      try {
        const result = await api.transcriptionStatus();
        if (!active || request !== statusRequest.current) return;
        setStatusFailed(!result.ok);
        if (result.ok) setStatus(result.value);
      } catch { if (active && request === statusRequest.current) setStatusFailed(true); }
      finally { fetching = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, saved]);

  useEffect(() => {
    if (!saved) return;
    const request = ++catalogRequest.current;
    setCatalog(null);
    setCatalogFailed(false);
    void api.transcriptionModels().then((result) => {
      if (!mounted.current || request !== catalogRequest.current) return;
      setCatalogFailed(!result.ok);
      if (result.ok) setCatalog(result.value);
    }).catch(() => { if (mounted.current && request === catalogRequest.current) setCatalogFailed(true); });
    return () => { catalogRequest.current++; };
  }, [api, saved]);

  const sameDestination = draft !== null && saved !== null && draft.provider === saved.provider && draft.baseUrl === saved.baseUrl;
  const remote = draft !== null && draft.provider !== 'whisper';
  const dirty = draft !== null && saved !== null && (draft.provider !== saved.provider || draft.model !== saved.model
    || draft.baseUrl !== saved.baseUrl || draft.timeoutMs !== saved.timeoutMs || key !== '' || removeKey);
  const models: TranscriptionModel[] = sameDestination ? catalog?.models.filter((model) => model.provider === draft?.provider) ?? [] : [];
  const manual = draft?.provider === 'custom';

  function edit(patch: Partial<Settings>) {
    if (pending.current) return;
    setDraft((current) => current ? { ...current, ...patch } : current);
    setConfirmed(false);
    setFailed(false);
  }

  async function save() {
    if (!draft || pending.current) return;
    pending.current = true;
    statusRequest.current++;
    catalogRequest.current++;
    setBusy(true);
    setFailed(false);
    setConfirmed(false);
    try {
      const result = await api.setTranscriptionSettings({ ...draft, ...(key !== '' ? { apiKey: key } : {}), ...(removeKey ? { removeApiKey: true } : {}) });
      if (!mounted.current) return;
      if (!result.ok) { setFailed(true); return; }
      setSaved(result.value);
      const { apiKeyConfigured: _configured, ...value } = result.value;
      setDraft(value);
      setKey('');
      setRemoveKey(false);
      setStatus(null);
      setConfirmed(true);
    } catch { if (mounted.current) setFailed(true); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  async function refreshModels() {
    if (pending.current || !sameDestination) return;
    pending.current = true;
    setBusy(true);
    setCatalogFailed(false);
    const request = ++catalogRequest.current;
    try {
      const result = await api.transcriptionModels();
      if (!mounted.current || request !== catalogRequest.current) return;
      setCatalogFailed(!result.ok);
      if (result.ok) setCatalog(result.value);
    } catch { if (mounted.current && request === catalogRequest.current) setCatalogFailed(true); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  return (
    <section aria-labelledby="settings-transcription" data-slot="transcription-settings">
      <SectionHeading id="settings-transcription">{t('settings.transcription.title')}</SectionHeading>
      {loading && <p role="status" className="text-sm text-muted-foreground">{t('settings.transcription.loading')}</p>}
      {draft && !loading && <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Group>
          <Row icon={Mic} id="transcription-provider-label" title={t('settings.transcription.provider')}
            description={t('settings.transcription.defaultHint')}
            trailing={<select data-slot="transcription-provider" aria-labelledby="transcription-provider-label" className={CONTROL} value={draft.provider} disabled={busy}
              onChange={(event) => {
                const provider = event.target.value as TranscriptionProvider;
                edit({ provider, model: DEFAULT_MODELS[provider], baseUrl: '' });
                setKey(''); setRemoveKey(false);
              }}>
              {PROVIDERS.map((provider) => <option key={provider} value={provider}>{t(`settings.transcription.providers.${provider}`)}</option>)}
            </select>} />
          <Row id="transcription-model-label" title={t('settings.transcription.model')}
            description={manual ? t('settings.transcription.manualHint') : undefined}
            trailing={manual ? <input data-slot="transcription-model" aria-labelledby="transcription-model-label" className={`${CONTROL} w-64 font-mono`} value={draft.model}
              required maxLength={500} pattern="[^\s]+" disabled={busy} list="transcription-models" onChange={(event) => edit({ model: event.target.value })} />
              : <select data-slot="transcription-model" aria-labelledby="transcription-model-label" className={`${CONTROL} w-64`} value={draft.model} disabled={busy}
                onChange={(event) => edit({ model: event.target.value })}>
                {!models.some((model) => model.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
                {models.map((model) => <option key={model.id} value={model.id}>{model.name}{model.deprecated ? ` · ${t('settings.transcription.deprecated')}` : ''}</option>)}
              </select>} />
          {manual && <>
            <datalist id="transcription-models">{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
            <Row id="transcription-url-label" title={t('settings.transcription.baseUrl')} description={t('settings.transcription.endpointHint')}
              trailing={<input data-slot="transcription-url" aria-labelledby="transcription-url-label" className={`${CONTROL} w-64 font-mono`} type="url" required maxLength={2000}
                placeholder="http://127.0.0.1:8000/v1" value={draft.baseUrl} disabled={busy}
                onChange={(event) => { edit({ baseUrl: event.target.value }); setKey(''); setRemoveKey(false); }} />} />
          </>}
          {remote && <>
            <Row id="transcription-key-label" title={t('settings.transcription.apiKey')}
              description={t(`settings.transcription.${sameDestination && saved?.apiKeyConfigured ? 'keyConfigured' : 'keyEmpty'}`)}
              trailing={<input data-slot="transcription-key" aria-labelledby="transcription-key-label" className={`${CONTROL} w-64`} type="password" autoComplete="new-password"
                maxLength={8000} value={key} disabled={busy || removeKey} onChange={(event) => { setKey(event.target.value); setConfirmed(false); }} />} />
            {sameDestination && saved?.apiKeyConfigured && <Row id="transcription-remove-key" title={t('settings.transcription.removeKey')}
              trailing={<Switch labelledBy="transcription-remove-key" checked={removeKey} disabled={busy}
                onCheckedChange={(value) => { setRemoveKey(value); setKey(''); setConfirmed(false); }} />} />}
          </>}
          <Row id="transcription-timeout-label" title={t('settings.transcription.timeout')}
            trailing={<input aria-labelledby="transcription-timeout-label" className={`${CONTROL} w-24 tabular-nums`} type="number" min={5} max={180} step={1} required disabled={busy}
              value={Number.isFinite(draft.timeoutMs) ? draft.timeoutMs / 1000 : ''} onChange={(event) => edit({ timeoutMs: event.target.valueAsNumber * 1000 })} />} />
          <Row title={t('settings.transcription.current')} description={<span role="status">{t(`settings.transcription.states.${statusFailed ? 'unreachable' : status?.state ?? 'loading'}`)}
            {status && !statusFailed && <span className="selectable"> · {t(`settings.transcription.providers.${status.provider}`)} · {status.model}</span>}</span>} />
        </Group>
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">{t(`settings.transcription.${remote ? 'privacy' : 'offline'}`)}</p>
        {remote && <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{t('settings.transcription.keyDestination')}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>{t('settings.transcription.save')}</Button>
          <Button icon={<RefreshCw aria-hidden="true" />} disabled={busy || !sameDestination || key !== '' || removeKey} onClick={() => void refreshModels()}>{t('settings.transcription.refreshModels')}</Button>
          {confirmed && <span role="status" className="text-sm text-success">{t('settings.transcription.saved')}</span>}
        </div>
        {(!sameDestination || key !== '' || removeKey) && <p className="mt-2 text-[13px] text-muted-foreground">{t('settings.transcription.saveBeforeModels')}</p>}
        {catalogFailed && <p role="alert" className="mt-2 text-sm text-destructive">{t('settings.transcription.modelsFailed')}</p>}
      </form>}
      {failed && <div role="alert" className="mt-2 flex items-center gap-2 text-sm text-destructive">
        <span>{t('settings.transcription.failed')}</span>
        <Button disabled={busy || loading} onClick={() => draft ? void save() : setReload((value) => value + 1)}>{t('settings.transcription.retry')}</Button>
      </div>}
    </section>
  );
}
