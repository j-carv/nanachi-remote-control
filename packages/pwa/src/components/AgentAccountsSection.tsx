import { useMemo, useState } from 'react';
import type { AgentAccount } from '@nanachi/shared';
import { createApiClient, type ApiClient } from '../api.js';
import { accountView, checkedText } from '../agentAccounts.js';
import { ErrorNotice } from './ErrorNotice.js';
import type { Machine } from '../machines.js';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';

interface AgentAccountsSectionProps {
  /** Máquina cujos agentes são verificados. Quem chama usa `key={machine.id}` para zerar ao trocar. */
  machine: Machine;
  nav: Navigator;
}

/** Ajustes → "Contas dos agentes": quem está logado em cada harness da máquina escolhida. */
export function AgentAccountsSection({ machine, nav }: AgentAccountsSectionProps) {
  const api: ApiClient = useMemo(
    () => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }),
    [machine.baseUrl, machine.token],
  );
  const list = useAsync(() => api.agentAccounts(false), [api]);
  const [refreshed, setRefreshed] = useState<AgentAccount[] | null>(null);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const accounts = refreshed ?? list.data;
  const error = refreshError ?? list.error;
  const now = Date.now();

  async function refresh() {
    setBusy(true);
    setRefreshError(null);
    try {
      setRefreshed(await api.agentAccounts(true));
    } catch (caught) {
      setRefreshError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2 className="section-title">Contas dos agentes</h2>
      <p className="muted">Login de cada agente em {machine.name}.</p>

      <ErrorNotice error={error} onRepair={() => nav.push({ kind: 'pair', baseUrl: machine.baseUrl })} />

      {accounts === null && error === null && <p className="muted">Verificando…</p>}

      {accounts !== null && (
        <ul className="item-list">
          {accounts.map((account) => (
            <AccountRow key={account.agentId} account={account} now={now} />
          ))}
        </ul>
      )}

      <button
        type="button"
        className="button secondary"
        disabled={busy || list.loading}
        onClick={() => void refresh()}
      >
        {busy ? 'Atualizando…' : 'Atualizar'}
      </button>
    </section>
  );
}

function AccountRow({ account, now }: { account: AgentAccount; now: number }) {
  const view = accountView(account);
  return (
    <li className="account-row">
      <div className="account-head">
        <span className="account-title">{account.label}</span>
        <span className={`account-status account-status-${view.tone}`}>
          <span className={`dot dot-${view.tone}`} aria-hidden="true" />
          {view.statusLabel}
        </span>
      </div>
      {account.account !== null && <span className="account-email">{account.account}</span>}
      {account.detail !== null && <span className="muted small">{account.detail}</span>}
      {view.help !== null && <span className="muted small">{view.help}</span>}
      <span className="muted small">{checkedText(account.checkedAt, now)}</span>
    </li>
  );
}
