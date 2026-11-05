import { useMemo, useState } from 'react';
import { Bot, CircleCheck, CircleDashed, RefreshCw, TriangleExclamationPoint, type LucideIcon } from 'lucide-react';
import type { AgentAccount } from '@nanachi/shared';
import { createApiClient, type ApiClient } from '../api.js';
import { accountView, checkedText } from '../agentAccounts.js';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listRowClass, SectionHeading } from './ListGroup.js';
import { Button } from '@/components/ui/button';
import { TONE_TEXT, type StatusTone } from './StatusDot.js';
import type { Machine } from '../machines.js';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';
import { cn } from '@/lib/utils';

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
    <section aria-labelledby="agent-accounts-title" className="flex flex-col gap-2">
      <SectionHeading
        icon={Bot}
        id="agent-accounts-title"
        action={
          <Button
            variant="ghost"
            size="icon"
            aria-label={busy ? 'Atualizando contas' : 'Atualizar contas'}
            disabled={busy || list.loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn(busy && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
          </Button>
        }
      >
        Contas dos agentes
      </SectionHeading>

      <p className="pl-1 text-sm text-muted-foreground">Login de cada agente em {machine.name}.</p>

      <ErrorNotice error={error} onRepair={() => nav.push({ kind: 'pair', baseUrl: machine.baseUrl })} />

      {accounts === null && error === null && <p className="pl-1 text-sm text-muted-foreground">Verificando…</p>}

      {accounts !== null && (
        <ListGroup>
          {accounts.map((account) => (
            <AccountRow key={account.agentId} account={account} now={now} />
          ))}
        </ListGroup>
      )}
    </section>
  );
}

const ACCOUNT_ICON: Record<'ok' | 'warn' | 'muted', { tone: StatusTone; Icon: LucideIcon }> = {
  ok: { tone: 'success', Icon: CircleCheck },
  warn: { tone: 'attention', Icon: TriangleExclamationPoint },
  muted: { tone: 'muted', Icon: CircleDashed },
};

function AccountRow({ account, now }: { account: AgentAccount; now: number }) {
  const view = accountView(account);
  const { tone, Icon } = ACCOUNT_ICON[view.tone];
  return (
    <li className={cn(listRowClass, 'items-start py-3')}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-base font-medium">{account.label}</span>
        {account.account !== null && <span className="truncate text-sm text-foreground/80">{account.account}</span>}
        {account.detail !== null && <span className="text-sm text-muted-foreground">{account.detail}</span>}
        {view.help !== null && <span className="text-sm text-muted-foreground">{view.help}</span>}
        <span className="pt-0.5 text-xs text-muted-foreground">{checkedText(account.checkedAt, now)}</span>
      </div>
      <span className={cn('flex shrink-0 items-center gap-1.5 text-sm', TONE_TEXT[tone])}>
        <Icon className="size-4" aria-hidden="true" />
        <span className="text-foreground">{view.statusLabel}</span>
      </span>
    </li>
  );
}
