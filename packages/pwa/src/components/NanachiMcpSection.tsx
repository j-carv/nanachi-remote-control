import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NanachiMcpResponse } from '@nanachi/shared';
import { createApiClient } from '../api.js';
import type { Machine } from '../machines.js';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listRowClass, SectionHeading } from './ListGroup.js';
import { Switch } from '@/components/ui/switch';

type Failure = { kind: 'load' } | { kind: 'save'; agentId: string; enabled: boolean };

interface McpState {
  data: NanachiMcpResponse | null;
  loading: boolean;
  saving: string | null;
  failure: Failure | null;
}

/** The caller keys this section by machine id so another PC never inherits confirmed preferences. */
export function NanachiMcpSection({ machine }: { machine: Machine }) {
  const api = useMemo(
    () => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }),
    [machine.baseUrl, machine.token],
  );
  const [state, setState] = useState<McpState>({ data: null, loading: true, saving: null, failure: null });
  const [version, setVersion] = useState(0);
  const request = useRef({ active: false, busy: false });

  useEffect(() => {
    const scope = { active: true, busy: true };
    request.current = scope;
    setState({ data: null, loading: true, saving: null, failure: null });
    api.nanachiMcpAgents().then(
      (data) => {
        if (scope.active) setState({ data, loading: false, saving: null, failure: null });
        scope.busy = false;
      },
      () => {
        if (scope.active) setState((previous) => ({ ...previous, loading: false, failure: { kind: 'load' } }));
        scope.busy = false;
      },
    );
    return () => {
      scope.active = false;
    };
  }, [api, version]);

  async function change(agentId: string, enabled: boolean) {
    const scope = request.current;
    if (!scope.active || scope.busy || state.data === null) return;
    scope.busy = true;
    setState((previous) => ({ ...previous, saving: agentId, failure: null }));
    try {
      const data = await api.setNanachiMcpAgent(agentId, enabled);
      if (scope.active) setState({ data, loading: false, saving: null, failure: null });
    } catch {
      if (scope.active) {
        setState((previous) => ({ ...previous, saving: null, failure: { kind: 'save', agentId, enabled } }));
      }
    } finally {
      scope.busy = false;
    }
  }

  function retry() {
    if (request.current.busy) return;
    if (state.failure?.kind === 'save') void change(state.failure.agentId, state.failure.enabled);
    else setVersion((previous) => previous + 1);
  }

  return <NanachiMcpSectionView machineName={machine.name} state={state} onChange={change} onRetry={retry} />;
}

/** Kept separate from requests so the static language sweeps can cover confirmed, pending and failed states. */
export function NanachiMcpSectionView({
  machineName,
  state,
  onChange,
  onRetry,
}: {
  machineName: string;
  state: McpState;
  onChange(agentId: string, enabled: boolean): void;
  onRetry(): void;
}) {
  const { t } = useTranslation('settings');
  const id = useId();
  const busy = state.loading || state.saving !== null;

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-2">
      <SectionHeading icon={Plug} id={`${id}-heading`}>{t('mcp.heading')}</SectionHeading>
      <p className="pl-1 text-sm text-muted-foreground">{t('mcp.description', { machine: machineName })}</p>
      <p id={`${id}-scope`} className="pl-1 text-sm text-muted-foreground">{t('mcp.scope')}</p>

      {state.loading && <p role="status" className="pl-1 text-sm text-muted-foreground">{t('mcp.loading')}</p>}
      {state.data !== null && state.data.agents.length === 0 && (
        <p className="pl-1 text-sm text-muted-foreground">{t('mcp.empty')}</p>
      )}
      {state.data !== null && state.data.agents.length > 0 && (
        <ListGroup>
          {state.data.agents.map((agent) => {
            const switchId = `${id}-${agent.id}`;
            const saving = state.saving === agent.id;
            return (
              <li key={agent.id} className={listRowClass} aria-busy={saving}>
                <label htmlFor={switchId} className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5">
                  <span className="break-words text-base">{agent.label}</span>
                  <span className="text-sm text-muted-foreground" role="status">
                    {t(saving ? 'mcp.saving' : agent.enabled ? 'mcp.enabled' : 'mcp.disabled')}
                  </span>
                </label>
                <Switch
                  id={switchId}
                  className="relative after:absolute after:inset-x-0 after:-inset-y-2 after:content-['']"
                  aria-label={t('mcp.toggle', { agent: agent.label })}
                  aria-describedby={`${id}-scope`}
                  checked={agent.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => onChange(agent.id, enabled)}
                />
              </li>
            );
          })}
        </ListGroup>
      )}
      {state.failure !== null && !busy && (
        <ErrorNotice
          message={t(state.failure.kind === 'load' ? 'mcp.loadFailed' : 'mcp.saveFailed')}
          action={{ label: t('mcp.retry'), onClick: onRetry }}
        />
      )}
    </section>
  );
}
