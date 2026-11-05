import { MessagesSquare, RefreshCw, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { AccountInfo, AgentAccountsInfo } from '../../common/control-api.js';
import type { Tone } from '../lib/status.js';
import { useApi } from '../state/api.js';
import { settle, useResource } from '../state/resource.js';
import { useShell } from '../state/shell.js';
import { Badge } from '../ui/Badge.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import { Notice } from '../ui/Notice.js';
import { StatusDot } from '../ui/StatusDot.js';
import { EmptyState, ErrorState, GroupSkeleton } from '../ui/States.js';
import { Group, SectionHeading } from '../ui/Surface.js';
import { useToast } from '../ui/Toast.js';
import { Tooltip } from '../ui/Tooltip.js';
import { Page } from './Page.js';

const STATUS: Record<AccountInfo['status'], { text: string; tone: Tone }> = {
  logged_in: { text: 'Conectada', tone: 'success' },
  logged_out: { text: 'Sem login', tone: 'muted' },
  unknown: { text: 'Não verificada', tone: 'muted' },
};

export interface AccountsViewProps {
  agents: AgentAccountsInfo[];
  /** `agentId:accountId` of the call in flight. */
  settingActive: string | null;
  onSetActive: (agent: AgentAccountsInfo, account: AccountInfo) => void;
  onOpenSessions: () => void;
}

function AccountRow({ agent, account, busy, onSetActive }: { agent: AgentAccountsInfo; account: AccountInfo; busy: boolean; onSetActive: () => void }) {
  const status = STATUS[account.status];
  return (
    <li data-slot="account-row" data-status={account.status} className="flex min-h-14 items-center gap-3 px-4 py-2">
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
        <UserRound aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{account.name}</span>
          {account.principal && account.name.toLowerCase() !== 'principal' ? <Badge>Principal</Badge> : null}
          {account.active ? <Badge tone="success">Em uso</Badge> : null}
        </div>
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <StatusDot tone={status.tone} />
          <span className={cx(account.status === 'logged_in' && 'text-foreground')}>{status.text}</span>
          {account.identity ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="selectable truncate">{account.identity}</span>
            </>
          ) : null}
        </div>
      </div>
      {!account.active && account.status === 'logged_in' && agent.multiAccount ? (
        <Button size="sm" loading={busy} onClick={onSetActive}>
          Usar em novas sessões
        </Button>
      ) : null}
    </li>
  );
}

export function AccountsView({ agents, settingActive, onSetActive, onOpenSessions }: AccountsViewProps) {
  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <EmptyState icon={UserRound} title="Nenhum agente configurado" description="Quando o daemon tiver agentes com login, as contas deles aparecem aqui." />
      </div>
    );
  }
  return (
    <>
      {agents.map((agent) => {
        const headingId = `accounts-${agent.agentId}`;
        return (
          <section key={agent.agentId} aria-labelledby={headingId}>
            <SectionHeading
              id={headingId}
              action={<span className="text-xs text-muted-foreground">{agent.multiAccount ? `${agent.accounts.length} ${agent.accounts.length === 1 ? 'conta' : 'contas'}` : 'Só a conta principal'}</span>}
            >
              {agent.agentName}
            </SectionHeading>
            <Group>
              <ul className="divide-y divide-border" aria-labelledby={headingId}>
                {agent.accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    agent={agent}
                    account={account}
                    busy={settingActive === `${agent.agentId}:${account.id}`}
                    onSetActive={() => onSetActive(agent, account)}
                  />
                ))}
              </ul>
            </Group>
          </section>
        );
      })}
      <Notice
        action={
          <Button icon={<MessagesSquare aria-hidden="true" />} onClick={onOpenSessions}>
            Abrir sessões
          </Button>
        }
      >
        Para adicionar uma conta ou entrar em uma, use o app de sessões. Aqui você só escolhe qual conta as novas sessões usam.
      </Notice>
    </>
  );
}

export function AccountsSection() {
  const api = useApi();
  const shell = useShell();
  const toast = useToast();
  const accounts = useResource(() => api.accounts.list());
  const [settingActive, setSettingActive] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // "Atualizar" asks the daemon to check the logins again; the plain list is cached for a few minutes.
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    const result = await settle(() => api.accounts.list(true));
    setRefreshing(false);
    if (result.ok) accounts.setData(result.value);
    else toast({ tone: 'error', title: 'Não foi possível atualizar', message: result.message });
  };

  const setActive = async (agent: AgentAccountsInfo, account: AccountInfo): Promise<void> => {
    setSettingActive(`${agent.agentId}:${account.id}`);
    const result = await settle(() => api.accounts.setActive(agent.agentId, account.id));
    setSettingActive(null);
    if (result.ok) {
      accounts.setData(result.value);
      toast({ tone: 'success', message: `Novas sessões do ${agent.agentName} vão usar ${account.name}.` });
    } else {
      toast({ tone: 'error', title: 'Não foi possível trocar a conta', message: result.message });
    }
  };

  let body;
  if (accounts.state.status === 'loading') {
    body = (
      <>
        <GroupSkeleton rows={2} />
        <GroupSkeleton rows={2} />
      </>
    );
  } else if (accounts.state.status === 'error') body = <ErrorState error={accounts.state.error} onRetry={() => void accounts.reload()} />;
  else body = <AccountsView agents={accounts.state.data} settingActive={settingActive} onSetActive={(agent, account) => void setActive(agent, account)} onOpenSessions={shell.openSessions} />;

  return (
    <Page
      section="accounts"
      actions={
        <Tooltip label="Verificar os logins de novo">
          <Button icon={<RefreshCw className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />} disabled={accounts.state.status === 'loading' || refreshing} onClick={() => void refresh()}>
            Atualizar
          </Button>
        </Tooltip>
      }
    >
      {body}
    </Page>
  );
}
