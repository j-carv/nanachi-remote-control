import type { ReactNode } from 'react';
import { Bot, ChevronDown, Gauge, Timer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { MarkdownText } from '../components/MarkdownText.js';
import { SectionHeading } from '../components/ListGroup.js';
import type { ParsedUsage, UsageSession, UsageWindow } from './parseUsage.js';
import {
  accountName,
  barWidth,
  formatCost,
  formatPercent,
  formatTokens,
  totalTokens,
  usageTone,
  windowGroups,
  type UsageTone,
} from './usageModel.js';

const BAR_TONE: Record<UsageTone, string> = {
  normal: 'bg-foreground',
  warning: 'bg-attention',
  critical: 'bg-destructive',
};

/** Placeholder for the loading state: the same card and tile shapes as the loaded panel. */
export function UsageSkeleton() {
  return (
    <div role="status" aria-label="Carregando uso" className="flex flex-col gap-5 py-1">
      <div className="grid grid-cols-2 gap-3">
        {[0, 1].map((key) => (
          <div key={key} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <SkeletonBlock className="h-4 w-2/3" />
            <SkeletonBlock className="h-9 w-1/2" />
            <SkeletonBlock className="h-1.5 w-full" />
            <SkeletonBlock className="h-3.5 w-3/4" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((key) => (
          <SkeletonBlock key={key} className="h-16 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

export function SkeletonBlock({ className }: { className: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)} />;
}

function WindowCard({ window }: { window: UsageWindow }) {
  const tone = usageTone(window.usedPercent);
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-medium text-muted-foreground">{window.label}</h3>
        {window.inUse === true && (
          <Badge variant="outline" className="shrink-0">
            em uso
          </Badge>
        )}
      </div>
      <p className="text-3xl font-semibold tabular-nums">
        {window.usedPercent === null ? '—' : formatPercent(window.usedPercent)}
      </p>
      {window.usedPercent !== null && (
        <div
          role="progressbar"
          aria-label={`Uso: ${window.label}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(barWidth(window.usedPercent))}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
              BAR_TONE[tone],
            )}
            style={{ width: `${barWidth(window.usedPercent)}%` }}
          />
        </div>
      )}
      {window.resetsAt !== undefined && (
        <p className="text-sm text-muted-foreground">{`Renova ${window.resetsAt}`}</p>
      )}
    </div>
  );
}

function SessionTiles({ session }: { session: UsageSession }) {
  const tiles: { label: string; value: string }[] = [];
  if (session.costUsd !== undefined) tiles.push({ label: 'Custo', value: formatCost(session.costUsd) });
  if (session.tokens !== undefined) tiles.push({ label: 'Tokens', value: formatTokens(totalTokens(session.tokens)) });
  if (session.durationText !== undefined) tiles.push({ label: 'Tempo ativo', value: session.durationText });

  return (
    <ul className="grid grid-cols-3 gap-2">
      {tiles.map((tile) => (
        <li key={tile.label} className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-card p-3">
          <span className="truncate text-xs text-muted-foreground">{tile.label}</span>
          <span className="truncate text-base font-semibold tabular-nums">{tile.value}</span>
        </li>
      ))}
    </ul>
  );
}

interface InfoRow {
  label: string;
  value: string;
  mono?: boolean;
}

function infoRows(usage: ParsedUsage): InfoRow[] {
  const rows: InfoRow[] = [];
  if (usage.model !== undefined) rows.push({ label: 'Modelo', value: usage.model, mono: true });
  const tokens = usage.session?.tokens;
  if (tokens !== undefined) {
    rows.push({ label: 'Entrada', value: formatTokens(tokens.input) });
    rows.push({ label: 'Saída', value: formatTokens(tokens.output) });
    rows.push({ label: 'Cache (leitura)', value: formatTokens(tokens.cacheRead) });
    rows.push({ label: 'Cache (escrita)', value: formatTokens(tokens.cacheWrite) });
  }
  for (const extra of usage.extras) rows.push({ label: extra.label, value: extra.value });
  return rows;
}

function InfoList({ rows }: { rows: InfoRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {rows.map((row, index) => (
        <li key={`${index}-${row.label}`} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2 text-sm">
          <span className="shrink-0 text-muted-foreground">{row.label}</span>
          <span className={cn('min-w-0 truncate text-right tabular-nums', row.mono === true && 'font-mono text-[0.8125rem]')}>
            {row.value}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The raw reply for whatever the parser did not understand. Open when nothing else was understood. */
function Details({ text, open }: { text: string; open: boolean }) {
  return (
    <details open={open} className="group rounded-xl border border-border bg-card">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        Detalhes
        <ChevronDown className="size-4 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
      </summary>
      <div className="border-t border-border px-4 py-3 text-sm">
        <MarkdownText text={text} />
      </div>
    </details>
  );
}

/**
 * The loaded panel: limit cards per account, the saved resets (`resets`, when the agent has them), the session tiles,
 * the model and extras, then the raw details.
 */
export function UsageBody({ usage, resets }: { usage: ParsedUsage; resets?: ReactNode }) {
  const groups = windowGroups(usage);
  const several = usage.accounts.length > 1;
  const rows = infoRows(usage);
  const hasUnderstood = usage.windows.length > 0 || usage.session !== undefined || rows.length > 0;
  const showDetails = usage.unparsed.trim() !== '';

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group, index) => {
        const id = `usage-group-${index}`;
        const title = several && group.account !== null ? accountName(group.account) : 'Limites';
        return (
          <section key={group.account?.id ?? 'other'} aria-labelledby={id} className="flex flex-col gap-2">
            <SectionHeading id={id} icon={several ? Bot : Gauge}>
              {title}
            </SectionHeading>
            <div className="grid grid-cols-2 gap-3">
              {group.windows.map((window, windowIndex) => (
                <WindowCard key={`${window.label}-${windowIndex}`} window={window} />
              ))}
            </div>
          </section>
        );
      })}

      {resets}

      {usage.session !== undefined && (
        <section aria-labelledby="usage-session" className="flex flex-col gap-2">
          <SectionHeading id="usage-session" icon={Timer}>
            Sessão
          </SectionHeading>
          <SessionTiles session={usage.session} />
        </section>
      )}

      {rows.length > 0 && <InfoList rows={rows} />}

      {showDetails && <Details text={usage.unparsed} open={!hasUnderstood} />}
    </div>
  );
}
