import { MessagesSquare, RefreshCw, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { agentIcons } from '../../../../shared/assets/agent-icons.js';
import type { AccountInfo, AgentAccountsInfo } from '../../common/control-api.js';
import { errorMessage } from '../lib/errors.js';
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
import { Group, rowStyle, SectionHeading } from '../ui/Surface.js';
import { useToast } from '../ui/Toast.js';
import { Tooltip } from '../ui/Tooltip.js';
import { Page } from './Page.js';

const STATUS = {
  logged_in: { text: 'accounts.status.loggedIn', tone: 'success' },
  logged_out: { text: 'accounts.status.loggedOut', tone: 'muted' },
  unknown: { text: 'accounts.status.unknown', tone: 'muted' },
} as const satisfies Record<AccountInfo['status'], { text: string; tone: Tone }>;

export interface AccountsViewProps {
  agents: AgentAccountsInfo[];
  /** `agentId:accountId` of the call in flight. */
  settingActive: string | null;
  onSetActive: (agent: AgentAccountsInfo, account: AccountInfo) => void;
  onOpenSessions: () => void;
}

function AccountRow({ agent, account, index, busy, onSetActive }: { agent: AgentAccountsInfo; account: AccountInfo; index: number; busy: boolean; onSetActive: () => void }) {
  const { t } = useTranslation();
  const status = STATUS[account.status];
  const mainLabel = t('accounts.main');
  const name = account.name.toLowerCase();
  return (
    <li
      data-slot="account-row"
      data-status={account.status}
      style={rowStyle(index)}
      className="animate-row flex min-h-14 items-center gap-3 px-4 py-2 transition-colors duration-150 ease-[var(--ease-premium)] hover:bg-accent/50"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
        <UserRound aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{account.name}</span>
          {account.principal && name !== 'principal' && name !== mainLabel.toLowerCase() ? <Badge>{mainLabel}</Badge> : null}
          {account.active ? <Badge tone="success">{t('accounts.inUse')}</Badge> : null}
        </div>
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <StatusDot tone={status.tone} />
          <span className={cx(account.status === 'logged_in' && 'text-foreground')}>{t(status.text)}</span>
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
          {t('accounts.useForNew')}
        </Button>
      ) : null}
    </li>
  );
}

export function AccountsView({ agents, settingActive, onSetActive, onOpenSessions }: AccountsViewProps) {
  const { t } = useTranslation();
  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <EmptyState icon={UserRound} title={t('accounts.emptyTitle')} description={t('accounts.emptyDescription')} />
      </div>
    );
  }
  return (
    <>
      {agents.map((agent) => {
        const headingId = `accounts-${agent.agentId}`;
        const icon = agentIcons.get(agent.agentId);
        return (
          <section key={agent.agentId} aria-labelledby={headingId}>
            <SectionHeading
              id={headingId}
              action={<span className="text-xs text-muted-foreground">{agent.multiAccount ? t('accounts.count', { count: agent.accounts.length }) : t('accounts.onlyMain')}</span>}
            >
              <span className="group inline-flex items-center gap-2">
                {icon !== undefined && (
                  <span className={cx('grid size-7 shrink-0 place-items-center rounded-md', agent.agentId === 'omp' ? 'bg-[#161616]' : 'bg-muted')}>
                    <img src={icon} alt="" className="size-5 object-contain" />
                  </span>
                )}
                {agent.agentName}
              </span>
            </SectionHeading>
            <Group>
              <ul className="divide-y divide-border" aria-labelledby={headingId}>
                {agent.accounts.map((account, index) => (
                  <AccountRow
                    key={account.id}
                    agent={agent}
                    account={account}
                    index={index}
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
            {t('common.openSessions')}
          </Button>
        }
      >
        {t('accounts.sessionsNotice')}
      </Notice>
    </>
  );
}

export function AccountsSection() {
  const { t } = useTranslation();
  const api = useApi();
  const shell = useShell();
  const toast = useToast();
  const accounts = useResource(() => api.accounts.list());
  const [settingActive, setSettingActive] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // "Refresh" asks the daemon to check the logins again; the plain list is cached for a few minutes.
  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    const result = await settle(() => api.accounts.list(true));
    setRefreshing(false);
    if (result.ok) accounts.setData(result.value);
    else toast({ tone: 'error', title: t('accounts.refreshFailedTitle'), message: errorMessage(result, t) });
  };

  const setActive = async (agent: AgentAccountsInfo, account: AccountInfo): Promise<void> => {
    setSettingActive(`${agent.agentId}:${account.id}`);
    const result = await settle(() => api.accounts.setActive(agent.agentId, account.id));
    setSettingActive(null);
    if (result.ok) {
      accounts.setData(result.value);
      toast({ tone: 'success', message: t('accounts.switched', { agent: agent.agentName, account: account.name }) });
    } else {
      toast({ tone: 'error', title: t('accounts.switchFailedTitle'), message: errorMessage(result, t) });
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
        <Tooltip label={t('accounts.refreshTip')}>
          <Button icon={<RefreshCw className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />} disabled={accounts.state.status === 'loading' || refreshing} onClick={() => void refresh()}>
            {t('accounts.refresh')}
          </Button>
        </Tooltip>
      }
    >
      {body}
    </Page>
  );
}
