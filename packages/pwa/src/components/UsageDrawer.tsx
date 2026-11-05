import { useEffect, useState } from 'react';
import { CircleExclamationPoint, RefreshCw } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { describeUsageError, usageNeedsResume } from '../errorMessages.js';
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
import { parseUsage, type ParsedUsage } from '../usage/parseUsage.js';
import { UsageBody, UsageSkeleton } from '../usage/UsageView.js';
import { headerSubtitle } from '../usage/usageModel.js';

export type UsageState =
  | { status: 'loading' }
  | {
      status: 'ready';
      text: string;
      fetchedAt: number;
      /** The reply came from the daemon cache, not from a new probe. */
      cached: boolean;
      usage: ParsedUsage;
    }
  | { status: 'error'; error: unknown };

/**
 * Starts one usage request and reports it through `onState`: `loading` first, then `ready` or `error`.
 * The returned function cancels the request. A response that arrives after cancel is dropped, so a closed
 * or refreshed panel never shows a result from an older request.
 */
export function startUsageRequest(
  client: Pick<ApiClient, 'fetchSessionUsage'>,
  sessionId: string,
  onState: (state: UsageState) => void,
): () => void {
  let current = true;
  onState({ status: 'loading' });
  client.fetchSessionUsage(sessionId).then(
    (usage) => {
      if (!current) return;
      onState({
        status: 'ready',
        text: usage.text,
        fetchedAt: usage.fetchedAt,
        cached: usage.cached === true,
        usage: parseUsage(usage.agent, usage.text),
      });
    },
    (error: unknown) => {
      if (current) onState({ status: 'error', error });
    },
  );
  return () => {
    current = false;
  };
}

/** Footer line for the time of the last successful reply, e.g. "Atualizado há 5 min · do cache". */
export function updatedLabel(fetchedAt: number, now: number, cached = false): string {
  const label = `Atualizado ${formatRelativeTime(fetchedAt, now)}`;
  return cached ? `${label} · do cache` : label;
}

interface UsageErrorProps {
  error: unknown;
  onResume(): void;
}

/** Inline error block, styled like ErrorNotice (which only knows the general texts). */
function UsageError({ error, onResume }: UsageErrorProps) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground">
      <div className="flex gap-3">
        <CircleExclamationPoint className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <p className="min-w-0 leading-5">{describeUsageError(error)}</p>
      </div>
      {usageNeedsResume(error) && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={onResume}>Retomar</Button>
        </div>
      )}
    </div>
  );
}

interface UsageContentProps {
  state: UsageState;
  /** Current time in ms, for the "Atualizado" line. */
  now: number;
  onRefresh(): void;
  onResume(): void;
}

/**
 * Body and footer of the usage panel, driven by `state`. Kept apart from `UsageDrawer` so the markup can be
 * rendered without a Drawer.
 */
export function UsageContent({ state, now, onRefresh, onResume }: UsageContentProps) {
  return (
    <>
      <div className="max-h-[70dvh] min-h-0 overflow-y-auto px-5 pt-4 pb-2">
        {state.status === 'loading' && <UsageSkeleton />}
        {state.status === 'ready' && state.text.trim().length === 0 && (
          <p className="text-sm text-muted-foreground">O agente não devolveu nada.</p>
        )}
        {state.status === 'ready' && state.text.trim().length > 0 && <UsageBody usage={state.usage} />}
        {state.status === 'error' && <UsageError error={state.error} onResume={onResume} />}
      </div>
      <DrawerFooter className="flex-row items-center justify-between gap-3 px-5 pt-3">
        <p className="min-w-0 text-sm text-muted-foreground">
          {state.status === 'ready' ? updatedLabel(state.fetchedAt, now, state.cached) : ''}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Atualizar uso"
          disabled={state.status === 'loading'}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </DrawerFooter>
    </>
  );
}

interface UsageDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: ApiClient;
  sessionId: string;
  agentName: string;
  /** Called by the "Retomar" button when the session is stopped and must be resumed first. */
  onResume: () => void;
}

/**
 * Folha "Uso do <agente>": mostra o uso e os limites que o agente informa (`/usage` ou `/status`). Carrega
 * ao abrir e a cada "Atualizar". Cada abertura começa um pedido novo; respostas antigas são descartadas.
 */
export function UsageDrawer({ open, onOpenChange, client, sessionId, agentName, onResume }: UsageDrawerProps) {
  const [state, setState] = useState<UsageState>({ status: 'loading' });
  // Bumped by the refresh button to start a new request while the panel stays open.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!open) return undefined;
    return startUsageRequest(client, sessionId, setState);
  }, [open, client, sessionId, refreshKey]);

  const subtitle = state.status === 'ready' ? headerSubtitle(state.usage.accounts) : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Uso do {agentName}</DrawerTitle>
          <DrawerDescription>{subtitle ?? 'Limites e consumo informados pelo agente.'}</DrawerDescription>
        </DrawerHeader>
        <UsageContent
          state={state}
          now={Date.now()}
          onRefresh={() => setRefreshKey((key) => key + 1)}
          onResume={onResume}
        />
      </DrawerContent>
    </Drawer>
  );
}
