import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Brain, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentsResponse, LearningModel, LearningModelsResponse, LearningSettingsResponse, UpdateLearningSettings } from '@nanachi/shared';
import { createApiClient } from '../api.js';
import type { Machine } from '../machines.js';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listRowClass, SectionHeading } from './ListGroup.js';
import { GlobalMemory } from './GlobalMemory.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

const SOURCES = ['same', 'agent', 'openrouter', 'openai', 'ollama'] as const;
type Agent = AgentsResponse['agents'][number];
const selectClass = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-ring';

function Field({ label, children }: { label: string; children(id: string): ReactNode }) {
  const id = useId();
  return <li className={`${listRowClass} flex-col items-stretch gap-1.5`}><label htmlFor={id} className="text-sm font-medium">{label}</label>{children(id)}</li>;
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange(value: boolean): void }) {
  const id = useId();
  return <li className={listRowClass}><label htmlFor={id} className="flex min-h-11 min-w-0 flex-1 items-center text-base">{label}</label><Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} className="relative after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']" /></li>;
}

export function groupLearningModels(models: readonly LearningModel[]): Map<string, LearningModel[]> {
  const groups = new Map<string, LearningModel[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group === undefined) groups.set(model.provider, [model]);
    else group.push(model);
  }
  return groups;
}

export interface LearningSettingsFormProps {
  settings: LearningSettingsResponse;
  agents: readonly Agent[];
  catalog: LearningModelsResponse | null;
  modelsLoading: boolean;
  modelsFailed: boolean;
  onRefresh(): void;
  onSave(input: UpdateLearningSettings): Promise<LearningSettingsResponse>;
}

/** Secrets exist only in this mounted form and the authenticated save request. */
export function LearningSettingsForm({ settings, agents, catalog, modelsLoading, modelsFailed, onRefresh, onSave }: LearningSettingsFormProps) {
  const { t } = useTranslation('learning');
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState('');
  const [removeApiKey, setRemoveApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [saved, setSaved] = useState(false);
  const mounted = useRef(true);
  const lock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings) || apiKey !== '' || removeApiKey;
  const reviewer = draft.reviewer;
  const remote = reviewer.source !== 'same' && reviewer.source !== 'agent';
  const connectionDirty = reviewer.source !== settings.reviewer.source || reviewer.baseUrl !== settings.reviewer.baseUrl || apiKey !== '' || removeApiKey;
  const models = remote && connectionDirty ? [] : (catalog?.models ?? []).filter((model) => model.source === reviewer.source && (reviewer.source !== 'agent' || model.agentId === reviewer.agentId));
  const groups = groupLearningModels(models);
  const patch = (next: Partial<LearningSettingsResponse>) => { setDraft((previous) => ({ ...previous, ...next })); setSaved(false); };

  async function save() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setFailure(false); setSaved(false);
    const { apiKeyConfigured: _configured, ...input } = draft;
    try {
      const confirmed = await onSave({ ...input, ...(apiKey !== '' ? { apiKey } : {}), ...(removeApiKey ? { removeApiKey: true } : {}) });
      if (mounted.current) { setDraft(confirmed); setApiKey(''); setRemoveApiKey(false); setSaved(true); }
    } catch { if (mounted.current) setFailure(true); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  return <form data-slot="learning-settings" className="flex min-w-0 flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <p className="text-sm text-muted-foreground">{t('consent')}</p>
    <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
      <ListGroup>
        <Toggle label={t('enabled')} checked={draft.enabled} disabled={busy} onChange={(enabled) => patch({ enabled })} />
        <Toggle label={t('approval')} checked={draft.approvalRequired} disabled={busy} onChange={(approvalRequired) => patch({ approvalRequired })} />
      </ListGroup>
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t('agents')}</legend>
        {agents.length === 0 ? <p className="text-sm text-muted-foreground">{t('emptyAgents')}</p> : <ListGroup>{agents.map((agent) => <Toggle key={agent.id} label={t('agentToggle', { agent: agent.label })} checked={draft.enabledAgents.includes(agent.id)} disabled={busy} onChange={(enabled) => patch({ enabledAgents: enabled ? [...draft.enabledAgents, agent.id] : draft.enabledAgents.filter((id) => id !== agent.id) })} />)}</ListGroup>}
        <p className="text-sm text-muted-foreground">{t('mcpHint')}</p>
      </fieldset>
      <ListGroup>
        <Field label={t('source')}>{(id) => <select id={id} data-slot="learning-source" className={selectClass} value={reviewer.source} onChange={(event) => { const source = SOURCES.find((value) => value === event.target.value); if (source !== undefined) { patch({ reviewer: { source, agentId: '', model: '', baseUrl: '' } }); setApiKey(''); setRemoveApiKey(false); } }}>{SOURCES.map((source) => <option key={source} value={source}>{t(`sources.${source}`)}</option>)}</select>}</Field>
        {reviewer.source === 'agent' && <Field label={t('agent')}>{(id) => <select id={id} data-slot="learning-agent" className={selectClass} value={reviewer.agentId} onChange={(event) => patch({ reviewer: { ...reviewer, agentId: event.target.value, model: '' } })}><option value="">{t('chooseAgent')}</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}</select>}</Field>}
        {(reviewer.source === 'openai' || reviewer.source === 'ollama') && <Field label={t('endpoint')}>{(id) => <Input id={id} data-slot="learning-endpoint" type="url" autoComplete="off" value={reviewer.baseUrl} maxLength={2000} onChange={(event) => patch({ reviewer: { ...reviewer, baseUrl: event.target.value, model: '' } })} />}</Field>}
        {remote && <Field label={t('apiKey')}>{(id) => <><Input id={id} data-slot="learning-api-key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} maxLength={8000} disabled={removeApiKey} onChange={(event) => { setApiKey(event.target.value); setSaved(false); }} /><p className="text-sm text-muted-foreground">{t(settings.apiKeyConfigured ? 'keyConfigured' : 'keyEmpty')}</p></>}</Field>}
        {remote && settings.apiKeyConfigured && <Toggle label={t('removeKey')} checked={removeApiKey} disabled={busy} onChange={(remove) => { setRemoveApiKey(remove); if (remove) setApiKey(''); setSaved(false); }} />}
        {reviewer.source !== 'same' && <Field label={t('model')}>{(id) => <select id={id} data-slot="learning-model" className={selectClass} value={reviewer.model} onChange={(event) => patch({ reviewer: { ...reviewer, model: event.target.value } })}><option value="">{t('chooseModel')}</option>{reviewer.model !== '' && !models.some((model) => model.id === reviewer.model) && <option value={reviewer.model}>{reviewer.model}</option>}{[...groups].map(([provider, options]) => <optgroup key={provider} label={provider || t('model')}>{options.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</optgroup>)}</select>}</Field>}
        {remote && <Field label={t('modelId')}>{(id) => <><Input id={id} data-slot="learning-model-id" autoComplete="off" spellCheck={false} value={reviewer.model} maxLength={500} onChange={(event) => patch({ reviewer: { ...reviewer, model: event.target.value } })} /><p className="text-sm text-muted-foreground">{t('manualHint')}</p></>}</Field>}
      </ListGroup>
      {reviewer.source === 'same' ? <p className="text-sm text-muted-foreground">{t('sameHint')}</p> : <>
        {remote && <p className="text-sm text-muted-foreground">{t('endpointHint')}</p>}
        {models.length === 0 && !modelsLoading && <p className="text-sm text-muted-foreground">{t('noModels')}</p>}
        <Button type="button" variant="secondary" data-slot="learning-refresh-models" aria-busy={modelsLoading} disabled={modelsLoading || (remote && connectionDirty)} onClick={onRefresh}><RefreshCw aria-hidden="true" className={`size-4 ${modelsLoading ? 'animate-spin motion-reduce:animate-none' : ''}`} />{t('refreshModels')}</Button>
      </>}
      {modelsFailed && <ErrorNotice message={t('modelsFailed')} {...(!modelsLoading && (!remote || !connectionDirty) ? { action: { label: t('retry'), onClick: onRefresh } } : {})} />}
      {catalog !== null && catalog.errors.length > 0 && <ul data-slot="learning-model-errors" className="flex flex-col gap-1 text-sm text-muted-foreground">{catalog.errors.map((error, index) => <li key={`${error.source}-${index}`} className="[overflow-wrap:anywhere]">{error.source}: {error.message}</li>)}</ul>}
      <details><summary className="flex min-h-11 items-center text-sm font-medium">{t('limits')}</summary><ListGroup>
        {([{ key: 'intervalTurns', min: 1, max: 100 }, { key: 'maxInputChars', min: 2000, max: 100000 }, { key: 'maxOutputTokens', min: 256, max: 8192 }, { key: 'timeoutMs', min: 5000, max: 180000 }] as const).map(({ key, min, max }) => <Field key={key} label={t(key)}>{(id) => <Input id={id} data-slot={`learning-${key}`} type="number" inputMode="numeric" required min={min} max={max} step={1} value={Number.isFinite(draft[key]) ? draft[key] : ''} onChange={(event) => patch({ [key]: event.target.valueAsNumber })} />}</Field>)}
      </ListGroup></details>
      <Button data-slot="learning-save" type="submit" disabled={busy || (!dirty && !failure)}>{t(busy ? 'saving' : 'save')}</Button>
    </fieldset>
    {failure && <ErrorNotice message={t('saveFailed')} />}
    <p role="status" className="text-sm text-muted-foreground">{saved && !dirty ? t('saved') : dirty ? t('unsaved') : null}</p>
  </form>;
}

export function LearningSection({ machine }: { machine: Machine }) {
  const { t } = useTranslation('learning');
  const heading = useId();
  const api = useMemo(() => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }), [machine.baseUrl, machine.token]);
  const [data, setData] = useState<{ settings: LearningSettingsResponse; agents: Agent[] } | null>(null);
  const [failure, setFailure] = useState(false);
  const [version, setVersion] = useState(0);
  const [catalog, setCatalog] = useState<LearningModelsResponse | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsFailed, setModelsFailed] = useState(false);
  const active = useRef(true);
  const modelsBusy = useRef(false);
  const modelGeneration = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setFailure(false);
    Promise.all([api.learningSettings(), api.fetchAgents()]).then(([settings, agents]) => { if (current) setData({ settings, agents: agents.filter((agent) => agent.kind === 'acp') }); }, () => { if (current) setFailure(true); });
    return () => { current = false; };
  }, [api, version]);
  async function refresh() {
    if (modelsBusy.current) return;
    const generation = ++modelGeneration.current;
    modelsBusy.current = true; setModelsLoading(true); setModelsFailed(false);
    try { const result = await api.learningModels(); if (active.current && generation === modelGeneration.current) setCatalog(result); }
    catch { if (active.current && generation === modelGeneration.current) setModelsFailed(true); }
    finally { if (generation === modelGeneration.current) { modelsBusy.current = false; if (active.current) setModelsLoading(false); } }
  }
  useEffect(() => { void refresh(); }, [api]);

  return <section data-slot="learning-section" aria-labelledby={heading} className="flex min-w-0 flex-col gap-3">
    <SectionHeading icon={Brain} id={heading}>{t('heading')}</SectionHeading>
    <p className="text-sm text-muted-foreground">{t('description')}</p>
    {data === null && !failure && <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>}
    {failure && <ErrorNotice message={t('loadFailed')} action={{ label: t('retry'), onClick: () => setVersion((value) => value + 1) }} />}
    {data !== null && <LearningSettingsForm settings={data.settings} agents={data.agents} catalog={catalog} modelsLoading={modelsLoading} modelsFailed={modelsFailed} onRefresh={() => void refresh()} onSave={async (input) => {
      const connectionChanged = input.reviewer.source !== data.settings.reviewer.source || input.reviewer.baseUrl !== data.settings.reviewer.baseUrl || input.apiKey !== undefined || input.removeApiKey === true;
      const settings = await api.saveLearningSettings(input);
      if (active.current) {
        setData((previous) => previous === null ? null : { ...previous, settings });
        if (connectionChanged) {
          modelGeneration.current += 1;
          modelsBusy.current = false;
          setCatalog(null);
          setModelsLoading(false);
          setModelsFailed(false);
        }
      }
      return settings;
    }} />}
    <GlobalMemory api={api} />
  </section>;
}
