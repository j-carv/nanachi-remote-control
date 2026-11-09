import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, CircleCheck, CircleDashed, Ellipsis, Plus, RefreshCw, TriangleExclamationPoint, type LucideIcon } from 'lucide-react';
import type { AgentAccount, AgentProfile } from '@nanachi/shared';
import { agentIcons } from '../../../shared/assets/agent-icons.js';
import { loadAgentAccounts } from '../agentAccountsCache.js';
import { createApiClient, type ApiClient } from '../api.js';
import {
  accountView,
  checkedText,
  createLoginReloads,
  profileActions,
  profileView,
  validateAccountLabel,
  type AccountTone,
  type ProfileAction,
} from '../agentAccounts.js';
import { describeAccountError } from '../errorMessages.js';
import { AccountLoginSheet } from './AccountLoginSheet.js';
import { ActionSheet, type ActionSheetItem } from './ActionSheet.js';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listRowClass, SectionHeading } from './ListGroup.js';
import { NameSheet } from './NameSheet.js';
import { RemoveAccountSheet } from './RemoveAccountSheet.js';
import { StatusDot, TONE_TEXT, type StatusTone } from './StatusDot.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Machine } from '../machines.js';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';
import { cn } from '@/lib/utils';

interface AgentAccountsSectionProps {
  /** Máquina cujos agentes são verificados. Quem chama usa `key={machine.id}` para zerar ao trocar. */
  machine: Machine;
  nav: Navigator;
}

/** The sheet or dialog that is open on top of the section. At most one at a time. */
type Flow =
  | { kind: 'actions'; agent: AgentAccount; profile: AgentProfile }
  | { kind: 'add'; agent: AgentAccount }
  | { kind: 'rename'; agent: AgentAccount; profile: AgentProfile }
  | { kind: 'remove'; agent: AgentAccount; profile: AgentProfile }
  | { kind: 'login'; agent: AgentAccount; accountId: string; accountLabel: string };

/** Ajustes → "Contas dos agentes": quem está logado em cada harness da máquina escolhida, e as contas extras dos que as têm. */
export function AgentAccountsSection({ machine, nav }: AgentAccountsSectionProps) {
  const { t } = useTranslation('accounts');
  const api: ApiClient = useMemo(
    () => createApiClient({ baseUrl: machine.baseUrl, token: machine.token }),
    [machine.baseUrl, machine.token],
  );
  // One list per machine, shared with the new-session sheet and the chat; any account change drops it (api.ts).
  const list = useAsync(() => loadAgentAccounts(api), [api]);
  const [refreshed, setRefreshed] = useState<AgentAccount[] | null>(null);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useState<Flow | null>(null);
  /** The work of the open sheet (create, rename, remove) and the error it ended with. */
  const [working, setWorking] = useState(false);
  const [flowError, setFlowError] = useState<unknown>(null);
  /** Error of an action that has no sheet of its own ("Usar em novas sessões"). */
  const [actionError, setActionError] = useState<unknown>(null);
  /** Reads the list again after a login: once when it succeeds, and when the sheet closes without that. */
  const loginReloads = useMemo(() => createLoginReloads(() => void reload()), [api]);
  const accounts = refreshed ?? list.data;
  const error = refreshError ?? list.error;
  const now = Date.now();
  const withAccounts = accounts?.filter((account) => account.supportsAccounts) ?? [];
  const plain = accounts?.filter((account) => !account.supportsAccounts) ?? [];

  async function refresh() {
    setBusy(true);
    setRefreshError(null);
    try {
      setRefreshed(await loadAgentAccounts(api, { refresh: true }));
    } catch (caught) {
      setRefreshError(caught);
    } finally {
      setBusy(false);
    }
  }

  /** Reads the list again after a change, without the full re-check of every agent. */
  async function reload() {
    try {
      setRefreshed(await loadAgentAccounts(api));
      setRefreshError(null);
    } catch (caught) {
      setRefreshError(caught);
    }
  }

  function closeFlow() {
    setFlow(null);
    setWorking(false);
    setFlowError(null);
  }

  function openFlow(next: Flow) {
    setFlowError(null);
    setWorking(false);
    if (next.kind === 'login') loginReloads.started();
    setFlow(next);
  }

  /** Runs the work of a sheet: busy while it runs, the error stays in the sheet, success closes it. */
  async function run(work: () => Promise<void>) {
    setWorking(true);
    setFlowError(null);
    try {
      await work();
    } catch (caught) {
      setFlowError(caught);
    } finally {
      setWorking(false);
    }
  }

  async function useForNewSessions(agent: AgentAccount, profile: AgentProfile) {
    setActionError(null);
    try {
      await api.setActiveAgentAccount(agent.agentId, profile.id);
      await reload();
    } catch (caught) {
      setActionError(caught);
    }
  }

  function actionItems(agent: AgentAccount, profile: AgentProfile): ActionSheetItem[] {
    const labels: Record<ProfileAction, () => ActionSheetItem> = {
      use: () => ({ label: t('actions.use'), onSelect: () => void useForNewSessions(agent, profile) }),
      login: () => ({
        label: t('actions.login'),
        onSelect: () => openFlow({ kind: 'login', agent, accountId: profile.id, accountLabel: profile.label }),
      }),
      rename: () => ({ label: t('actions.rename'), onSelect: () => openFlow({ kind: 'rename', agent, profile }) }),
      remove: () => ({ label: t('actions.remove'), tone: 'danger', onSelect: () => openFlow({ kind: 'remove', agent, profile }) }),
    };
    return profileActions(profile).map((action) => labels[action]());
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
            aria-label={busy ? t('section.refreshing') : t('section.refresh')}
            disabled={busy || list.loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn(busy && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
          </Button>
        }
      >
        {t('section.title')}
      </SectionHeading>

      <p className="pl-1 text-sm text-muted-foreground">{t('section.description', { machine: machine.name })}</p>

      <ErrorNotice error={error} onRepair={() => nav.push({ kind: 'pair', baseUrl: machine.baseUrl })} />
      {actionError !== null && <ErrorNotice message={describeAccountError(actionError)} />}

      {accounts === null && error === null && <p className="pl-1 text-sm text-muted-foreground">{t('section.checking')}</p>}

      {withAccounts.map((agent) => (
        <AgentAccountGroup
          key={agent.agentId}
          agent={agent}
          now={now}
          onOpen={(profile) => openFlow({ kind: 'actions', agent, profile })}
          onAdd={() => openFlow({ kind: 'add', agent })}
        />
      ))}

      {plain.length > 0 && (
        <ListGroup>
          {plain.map((account) => (
            <AccountRow key={account.agentId} account={account} now={now} />
          ))}
        </ListGroup>
      )}

      {flow?.kind === 'actions' && (
        <ActionSheet
          label={t('actions.label')}
          title={`${flow.agent.label} · ${flow.profile.label}`}
          items={actionItems(flow.agent, flow.profile)}
          onClose={closeFlow}
        />
      )}

      {flow?.kind === 'add' && (
        <NameSheet
          title={t('add.title')}
          description={t('add.description', { agent: flow.agent.label })}
          submitLabel={t('add.submit')}
          initialName=""
          busy={working}
          error={flowError}
          errorText={flowError === null ? undefined : describeAccountError(flowError)}
          validate={validateAccountLabel}
          capitalize
          onCancel={closeFlow}
          onSubmit={(label) =>
            void run(async () => {
              const created = await api.createAgentAccount(flow.agent.agentId, label);
              void reload();
              loginReloads.started();
              setFlow({ kind: 'login', agent: flow.agent, accountId: created.id, accountLabel: created.label });
            })
          }
        />
      )}

      {flow?.kind === 'rename' && (
        <NameSheet
          title={t('rename.title')}
          description={t('rename.description', { account: flow.profile.label, agent: flow.agent.label })}
          submitLabel={t('rename.submit')}
          initialName={flow.profile.label}
          busy={working}
          error={flowError}
          errorText={flowError === null ? undefined : describeAccountError(flowError)}
          validate={validateAccountLabel}
          capitalize
          onCancel={closeFlow}
          onSubmit={(label) =>
            void run(async () => {
              await api.renameAgentAccount(flow.agent.agentId, flow.profile.id, label);
              await reload();
              closeFlow();
            })
          }
        />
      )}

      {flow?.kind === 'remove' && (
        <RemoveAccountSheet
          agentLabel={flow.agent.label}
          accountLabel={flow.profile.label}
          busy={working}
          error={flowError}
          onCancel={closeFlow}
          onConfirm={() =>
            void run(async () => {
              await api.deleteAgentAccount(flow.agent.agentId, flow.profile.id);
              await reload();
              closeFlow();
            })
          }
        />
      )}

      {flow?.kind === 'login' && (
        <AccountLoginSheet
          api={api}
          agentId={flow.agent.agentId}
          agentLabel={flow.agent.label}
          accountId={flow.accountId}
          accountLabel={flow.accountLabel}
          onSucceeded={loginReloads.succeeded}
          onClose={() => {
            closeFlow();
            loginReloads.closed();
          }}
        />
      )}
    </section>
  );
}

const ACCOUNT_ICON: Record<'ok' | 'warn' | 'muted', { tone: StatusTone; Icon: LucideIcon }> = {
  ok: { tone: 'success', Icon: CircleCheck },
  warn: { tone: 'attention', Icon: TriangleExclamationPoint },
  muted: { tone: 'muted', Icon: CircleDashed },
};

const DOT_TONE: Record<AccountTone, StatusTone> = { ok: 'success', warn: 'attention', muted: 'muted' };

function ProviderIcon({ agentId }: { agentId: string }) {
  const icon = agentIcons.get(agentId);
  if (icon === undefined) return null;
  return (
    <span className={cn('grid size-7 shrink-0 place-items-center rounded-md', agentId === 'omp' ? 'bg-[#161616]' : 'bg-muted')}>
      <img src={icon} alt="" className="size-5 object-contain" />
    </span>
  );
}

interface AgentAccountGroupProps {
  agent: AgentAccount;
  now: number;
  /** A row was tapped: open the sheet of actions for that account. */
  onOpen(profile: AgentProfile): void;
  onAdd(): void;
}

/** An agent that has accounts: its name and when it was checked, one row per account, and "Adicionar conta". */
export function AgentAccountGroup({ agent, now, onOpen, onAdd }: AgentAccountGroupProps) {
  const { t } = useTranslation('accounts');
  return (
    <div role="group" aria-label={agent.label} data-slot="agent-accounts" className="flex flex-col gap-1.5 pt-1">
      <div className="flex items-baseline justify-between gap-3 pl-1">
        <h3 className="flex min-w-0 items-center gap-2 text-base font-medium">
          <ProviderIcon agentId={agent.agentId} />
          <span className="truncate">{agent.label}</span>
        </h3>
        <span className="shrink-0 text-xs text-muted-foreground">{checkedText(agent.checkedAt, now)}</span>
      </div>
      <ListGroup>
        {agent.profiles.map((profile) => (
          <ProfileRow key={profile.id} agent={agent} profile={profile} onOpen={() => onOpen(profile)} />
        ))}
        <li>
          <button
            type="button"
            data-slot="add-account"
            className={cn(listRowClass, 'w-full text-left transition-colors hover:bg-accent active:bg-accent')}
            onClick={onAdd}
          >
            <Plus className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="text-base">{t('add.title')}</span>
          </button>
        </li>
      </ListGroup>
    </div>
  );
}

/** One account of an agent that has several: status dot, name, e-mail, and the "Em uso" badge on the one new sessions use. */
function ProfileRow({ agent, profile, onOpen }: { agent: AgentAccount; profile: AgentProfile; onOpen(): void }) {
  const { t } = useTranslation('accounts');
  const view = profileView(profile);
  return (
    <li>
      <button
        type="button"
        data-slot="account-row"
        data-agent={agent.agentId}
        data-account={profile.id}
        data-active={profile.active ? 'true' : 'false'}
        aria-haspopup="dialog"
        className={cn(listRowClass, 'w-full items-start py-3 text-left transition-colors hover:bg-accent active:bg-accent')}
        onClick={onOpen}
      >
        <span className="mt-[7px]">
          <StatusDot tone={DOT_TONE[view.tone]} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base font-medium">{profile.label}</span>
            {profile.active && <Badge>{t('badge.inUse')}</Badge>}
          </span>
          <span className="truncate text-sm text-muted-foreground">{view.subtitle}</span>
          <span className="sr-only">{view.statusLabel}</span>
        </span>
        <Ellipsis className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </li>
  );
}

/** An agent without extra accounts: its one login, as before. */
function AccountRow({ account, now }: { account: AgentAccount; now: number }) {
  const view = accountView(account);
  const { tone, Icon } = ACCOUNT_ICON[view.tone];
  return (
    <li className={cn(listRowClass, 'items-start py-3')}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-base font-medium">
          <ProviderIcon agentId={account.agentId} />
          {account.label}
        </span>
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
