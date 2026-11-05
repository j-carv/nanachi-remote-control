import { useState } from 'react';
import { CircleCheck, Info, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { ResetEntry } from '@nanachi/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { describeResetsError } from '../errorMessages.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, SectionHeading } from '../components/ListGroup.js';
import { useModalOverlay } from '../components/useModalOverlay.js';
import type { RedeemState, ResetsListState } from './resetsFlow.js';
import {
  canRedeem,
  redeemConfirmText,
  resetCountsText,
  resetExpiryText,
  type RedeemResult,
} from './resetsModel.js';
import { SkeletonBlock } from './UsageView.js';

/** Placeholder while the list loads: the shape of one row. */
function ResetsSkeleton() {
  return (
    <div role="status" aria-label="Carregando resets" className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <SkeletonBlock className="h-5 w-2/3" />
      <SkeletonBlock className="h-4 w-1/2" />
    </div>
  );
}

/** The reply of the last redeem: neutral background, with the success icon for a spent reset, an error block for a failed request. */
function RedeemResultBody({ result }: { result: RedeemResult }) {
  if (result.tone === 'error') return <ErrorNotice message={result.message} />;
  const success = result.tone === 'success';
  const Icon = success ? CircleCheck : Info;
  return (
    <div
      role="status"
      data-slot="reset-result"
      data-tone={result.tone}
      className="flex gap-3 rounded-lg bg-muted p-4 text-sm text-foreground"
    >
      <Icon
        className={cn('mt-0.5 size-5 shrink-0', success ? 'text-success' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      <p className="min-w-0 leading-5 break-words">{result.message}</p>
    </div>
  );
}

/**
 * The reply of the last redeem. With `onDismiss` it has a close button: the reply stays until the next redeem or until
 * the user dismisses it, so it is still there when a redeem ended while the usage panel was closed.
 */
export function RedeemResultNotice({ result, onDismiss }: { result: RedeemResult; onDismiss?: (() => void) | undefined }) {
  if (onDismiss === undefined) return <RedeemResultBody result={result} />;
  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <RedeemResultBody result={result} />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Dispensar aviso"
        data-slot="reset-result-dismiss"
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

interface ResetRowProps {
  entry: ResetEntry;
  now: number;
  /** Some row is being redeemed: every button is disabled. */
  redeeming: boolean;
  /** This row is the one being redeemed: its button shows the spinner. */
  spinning: boolean;
  onAsk(): void;
}

function ResetRow({ entry, now, redeeming, spinning, onAsk }: ResetRowProps) {
  const expiry = resetExpiryText(entry.expiresAt, now);
  return (
    <li data-slot="reset-row" className="flex items-center gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-base font-medium break-words">{entry.accountLabel}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {entry.providerLabel !== null && <Badge variant="outline">{entry.providerLabel}</Badge>}
          <span className="text-sm text-muted-foreground tabular-nums">{resetCountsText(entry)}</span>
        </div>
        {expiry !== null && <p className="text-sm text-muted-foreground">{expiry}</p>}
        {entry.note !== null && <p className="text-sm text-muted-foreground break-words">{entry.note}</p>}
      </div>
      <Button
        type="button"
        variant="outline"
        aria-label={`Usar reset de ${entry.accountLabel}`}
        aria-busy={spinning ? true : undefined}
        disabled={!canRedeem(entry, redeeming)}
        onClick={onAsk}
      >
        {spinning && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        Usar reset
      </Button>
    </li>
  );
}

/** The two buttons of the confirmation. Only "Usar reset" spends anything; "Cancelar" is the one focused first. */
export function ResetConfirmActions({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  return (
    <DrawerFooter className="flex-row">
      <Button type="button" variant="secondary" className="flex-1" data-slot="reset-cancel" onClick={onCancel}>
        Cancelar
      </Button>
      <Button type="button" className="flex-1" data-slot="reset-confirm" onClick={onConfirm}>
        Usar reset
      </Button>
    </DrawerFooter>
  );
}

interface ResetConfirmSheetProps {
  entry: ResetEntry;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * "Usar 1 reset?": the confirmation over the usage panel. Closing it by any other way than "Usar reset" (Cancelar,
 * the back gesture, Esc, a tap outside, a drag down) sends nothing.
 */
function ResetConfirmSheet({ entry, onCancel, onConfirm }: ResetConfirmSheetProps) {
  useModalOverlay(onCancel);
  const text = redeemConfirmText(entry);
  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{text.title}</DrawerTitle>
          <DrawerDescription className="text-base leading-6 text-foreground/80">{text.body}</DrawerDescription>
        </DrawerHeader>
        <ResetConfirmActions onCancel={onCancel} onConfirm={onConfirm} />
      </DrawerContent>
    </Drawer>
  );
}

interface ResetsSectionProps {
  list: ResetsListState;
  redeem: RedeemState;
  /** Current time in ms, for the expiry text. */
  now: number;
  /** Called only after the confirmation's "Usar reset": the one place a redeem starts. */
  onRedeem(target: string): void;
  /** The reply of the last redeem got a close button when this is given. */
  onDismissRedeem?: (() => void) | undefined;
}

/**
 * "Resets salvos": the saved rate-limit resets of the agent's accounts (omp and codex). A row's "Usar reset" opens the
 * confirmation; only the confirmation's "Usar reset" calls `onRedeem`. While a redeem runs every row button is disabled.
 */
export function ResetsSection({ list, redeem, now, onRedeem, onDismissRedeem }: ResetsSectionProps) {
  const [asking, setAsking] = useState<ResetEntry | null>(null);
  const redeeming = redeem.status === 'running';

  return (
    <section aria-labelledby="usage-resets" className="flex flex-col gap-2">
      <SectionHeading id="usage-resets" icon={RotateCcw}>
        Resets salvos
      </SectionHeading>

      {redeem.status === 'done' && <RedeemResultNotice result={redeem.result} onDismiss={onDismissRedeem} />}

      {list.status === 'loading' && <ResetsSkeleton />}
      {list.status === 'error' && <ErrorNotice message={describeResetsError(list.error)} />}
      {list.status === 'ready' && list.entries.length === 0 && (
        <p data-slot="reset-message" className="px-1 text-sm text-muted-foreground">
          {list.message ?? 'Nenhum reset salvo.'}
        </p>
      )}
      {list.status === 'ready' && list.entries.length > 0 && (
        <ListGroup label="Resets salvos">
          {list.entries.map((entry, index) => (
            <ResetRow
              key={`${index}-${entry.target}`}
              entry={entry}
              now={now}
              redeeming={redeeming}
              spinning={redeem.status === 'running' && redeem.target === entry.target}
              onAsk={() => setAsking(entry)}
            />
          ))}
        </ListGroup>
      )}

      {asking !== null && (
        <ResetConfirmSheet
          entry={asking}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null);
            onRedeem(asking.target);
          }}
        />
      )}
    </section>
  );
}
