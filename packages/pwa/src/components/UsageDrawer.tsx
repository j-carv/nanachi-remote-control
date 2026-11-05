import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleExclamationPoint, RefreshCw } from 'lucide-react';
import type { SessionAccountInfo } from '../agentAccounts.js';
import type { ApiClient } from '../api.js';
import { describeUsageError, usageNeedsResume } from '../errorMessages.js';
import { t as translate } from '../i18n/index.js';
import { formatRelativeTime } from '../relativeTime.js';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import type { RedeemState, ResetsListState } from '../usage/resetsFlow.js';
import { supportsResets } from '../usage/resetsModel.js';
import { RedeemResultNotice, ResetsSection } from '../usage/ResetsSection.js';
import {
  createUsagePanel,
  INITIAL_PANEL_STATE,
  startUsageRequest,
  type UsagePanel,
  type UsagePanelState,
  type UsageState,
} from '../usage/usagePanel.js';
import { UsageBody, UsageSkeleton } from '../usage/UsageView.js';
import { headerSubtitle } from '../usage/usageModel.js';

export { startUsageRequest, type UsageState };

/** Footer line for the time of the last successful reply, e.g. "Atualizado há 5 min · do cache" / "Updated 5 min ago · from cache". */
export function updatedLabel(fetchedAt: number, now: number, cached = false): string {
  const time = formatRelativeTime(fetchedAt, now);
  return cached ? translate('usage:drawer.updatedCached', { time }) : translate('usage:drawer.updated', { time });
}

interface UsageErrorProps {
  error: unknown;
  onResume(): void;
}

/** Inline error block, styled like ErrorNotice (which only knows the general texts). */
function UsageError({ error, onResume }: UsageErrorProps) {
  const { t } = useTranslation('usage');
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground">
      <div className="flex gap-3">
        <CircleExclamationPoint className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <p className="min-w-0 leading-5">{describeUsageError(error)}</p>
      </div>
      {usageNeedsResume(error) && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={onResume}>{t('drawer.resume')}</Button>
        </div>
      )}
    </div>
  );
}

/** What the "Resets salvos" section shows and does. Only given for agents that have saved resets (omp, codex). */
export interface ResetsPanel {
  list: ResetsListState;
  redeem: RedeemState;
  /** Called after the confirmation of a row: the only way a redeem starts. */
  onRedeem(target: string): void;
  /** The user dismissed the reply of the last redeem. */
  onDismissRedeem(): void;
}

interface UsageContentProps {
  state: UsageState;
  /** Current time in ms, for the "Atualizado" line and the expiry of the resets. */
  now: number;
  onRefresh(): void;
  onResume(): void;
  resets?: ResetsPanel | undefined;
  /** The last refresh failed while `state` is still the last good answer: the footer says the numbers are old. */
  refreshFailed?: UsagePanelState['refreshFailed'] | undefined;
}

/** Footer line for a quiet refresh that failed: the numbers above are the last ones that worked. */
function RefreshFailedLine({ error }: { error: unknown }) {
  const { t } = useTranslation('usage');
  return (
    <p data-slot="usage-refresh-error" role="alert" className="flex items-start gap-1.5 text-sm text-foreground">
      <CircleExclamationPoint className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0">{t('drawer.refreshFailed', { reason: describeUsageError(error) })}</span>
    </p>
  );
}

/**
 * Body and footer of the usage panel, driven by `state`. Kept apart from `UsageDrawer` so the markup can be
 * rendered without a Drawer. `resets` adds the "Resets salvos" section under the limit cards.
 *
 * The reply of a redeem never depends on the usage state: with the usage loaded it sits in the section, otherwise
 * (loading, or an error on a new open) it is shown on its own at the top of the panel.
 */
export function UsageContent({ state, now, onRefresh, onResume, resets, refreshFailed }: UsageContentProps) {
  const { t } = useTranslation('usage');
  const resetsSection =
    resets === undefined ? undefined : (
      <ResetsSection
        list={resets.list}
        redeem={resets.redeem}
        now={now}
        onRedeem={resets.onRedeem}
        onDismissRedeem={resets.onDismissRedeem}
      />
    );
  const looseResult =
    resets !== undefined && state.status !== 'ready' && resets.redeem.status === 'done' ? (
      <div className="mb-5">
        <RedeemResultNotice result={resets.redeem.result} onDismiss={resets.onDismissRedeem} />
      </div>
    ) : null;
  // A redeem in flight must not be cut short by a new usage request: the refresh waits for it.
  const redeeming = resets?.redeem.status === 'running';
  return (
    <>
      <div className="max-h-[70dvh] min-h-0 overflow-y-auto px-5 pt-4 pb-2">
        {looseResult}
        {state.status === 'loading' && <UsageSkeleton />}
        {state.status === 'ready' && state.text.trim().length === 0 && (
          <div className="flex flex-col gap-5">
            <p className="text-sm text-muted-foreground">{t('drawer.empty')}</p>
            {resetsSection}
          </div>
        )}
        {state.status === 'ready' && state.text.trim().length > 0 && (
          <UsageBody usage={state.usage} resets={resetsSection} />
        )}
        {state.status === 'error' && <UsageError error={state.error} onResume={onResume} />}
      </div>
      <DrawerFooter className="flex-row items-center justify-between gap-3 px-5 pt-3">
        <div className="flex min-w-0 flex-col gap-1">
          {refreshFailed != null && state.status === 'ready' && <RefreshFailedLine error={refreshFailed.error} />}
          <p className="min-w-0 text-sm text-muted-foreground">
            {state.status === 'ready' ? updatedLabel(state.fetchedAt, now, state.cached) : ''}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('drawer.refresh')}
          disabled={state.status === 'loading' || redeeming}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </DrawerFooter>
    </>
  );
}

/** "Conta: <nome>" under the title, for agents that have accounts: which account the numbers belong to. */
export function UsageAccountLine({ account }: { account: SessionAccountInfo }) {
  const { t } = useTranslation('usage');
  return (
    <p data-slot="usage-account" className="text-sm text-foreground">
      {t('drawer.account')} <span className="font-medium">{account.label}</span>
      {account.email !== null && <span className="text-muted-foreground"> · {account.email}</span>}
    </p>
  );
}

interface UsageDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: ApiClient;
  sessionId: string;
  /** Id of the session's agent in the daemon config. Only `omp` and `codex` get the "Resets salvos" section. */
  agentId: string;
  agentName: string;
  /** The account of the session, when its agent has accounts. */
  account?: SessionAccountInfo | null | undefined;
  /** Called by the "Retomar" button when the session is stopped and must be resumed first. */
  onResume: () => void;
}

/** The panel logic (usage/usagePanel.ts) bound to React: one panel per client, session and agent kind. */
function useUsagePanel(client: ApiClient, sessionId: string, withResets: boolean, open: boolean) {
  const [state, setState] = useState<UsagePanelState>(INITIAL_PANEL_STATE);
  const panel = useRef<UsagePanel | null>(null);

  useEffect(() => {
    const created = createUsagePanel(client, sessionId, withResets, setState);
    panel.current = created;
    return () => {
      panel.current = null;
      created.dispose();
    };
  }, [client, sessionId, withResets]);

  // Declared after the effect that creates the panel, so it sees the new panel when the client or the session change.
  useEffect(() => {
    if (open) panel.current?.open();
    else panel.current?.close();
  }, [open, client, sessionId, withResets]);

  return {
    state,
    refresh: () => panel.current?.refresh(),
    redeem: (target: string) => panel.current?.redeem(target),
    dismissRedeem: () => panel.current?.dismissRedeem(),
  };
}

/**
 * Folha "Uso do <agente>": mostra o uso e os limites que o agente informa (/usage ou /status). Carrega
 * ao abrir e a cada "Atualizar". Cada abertura começa um pedido novo; respostas antigas são descartadas.
 *
 * Para omp e codex, depois do uso carregar, lista os resets salvos e deixa gastar um (docs/PLAN.md, "rate-limit
 * resets"). O resgate só começa na confirmação de uma linha. Depois de qualquer tentativa, uso e resets são lidos de
 * novo, sem trocar o painel por esqueleto, e a resposta do resgate continua na tela (também ao fechar e abrir a folha)
 * até um novo resgate ou até o usuário dispensá-la. Se a releitura falhar, o último uso bom continua. Nada é reenviado
 * sozinho.
 */
export function UsageDrawer({ open, onOpenChange, client, sessionId, agentId, agentName, account, onResume }: UsageDrawerProps) {
  const { t } = useTranslation('usage');
  const withResets = supportsResets(agentId);
  const panel = useUsagePanel(client, sessionId, withResets, open);
  const { usage: state, list, redeem, refreshFailed } = panel.state;

  const subtitle = state.status === 'ready' ? headerSubtitle(state.usage.accounts) : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('drawer.title', { agent: agentName })}</DrawerTitle>
          <DrawerDescription>{subtitle ?? t('drawer.description')}</DrawerDescription>
          {account != null && <UsageAccountLine account={account} />}
        </DrawerHeader>
        <UsageContent
          state={state}
          now={Date.now()}
          onRefresh={panel.refresh}
          onResume={onResume}
          resets={
            withResets ? { list, redeem, onRedeem: panel.redeem, onDismissRedeem: panel.dismissRedeem } : undefined
          }
          refreshFailed={refreshFailed}
        />
      </DrawerContent>
    </Drawer>
  );
}
