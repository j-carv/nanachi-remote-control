import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { ApiClient } from '../api.js';
import { Badge } from '@/components/ui/badge';
import { ToolContentView } from '../components/ToolContentView.js';
import { cn } from '@/lib/utils';
import { summarizeTool, type ToolItem } from './toolSummary.js';
import type { ToolCallStatus } from './reducer.js';
import { BackgroundJobRows, BackgroundStatus } from './BackgroundStatus.js';
import { effectiveState, type BackgroundState, type BackgroundView } from './background.js';
import { arrivedLive, type HistoryIds } from './liveItems.js';
import type { ChatNode } from './nesting.js';
import { NESTED_FRAME_CLASS } from './itemFrame.js';

export type { ToolItem } from './toolSummary.js';

const STATUS_TONE: Record<ToolCallStatus, string> = {
  pending: 'text-running',
  in_progress: 'text-running',
  completed: 'text-success',
  failed: 'text-destructive',
};

const NO_NODES: readonly ChatNode[] = [];

/** Chevron of a summary: turns when the card opens (the transition is the only motion here). */
const CHEVRON_CLASS =
  'size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-(--ease-out-premium) group-open:rotate-180 motion-reduce:transition-none';

/** State shown on the card: the background state when the call has one, else what its ACP status says. */
function cardState(item: ToolItem, view: BackgroundView): BackgroundState {
  if (item.background !== undefined) {
    return effectiveState({ background: item.background, timing: item.timing }, view);
  }
  switch (item.status) {
    case 'pending':
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case null:
      return 'unknown';
  }
}

/** Title of a child in the parent's "latest" line: its background label, or its summary title. */
function titleOf(node: ChatNode): string {
  if (node.item.kind !== 'tool_call') return '';
  return node.item.background?.label ?? summarizeTool(node.item).title;
}

export interface ToolCardProps {
  api: ApiClient;
  item: ToolItem;
  /** Tool calls this one made (its children), in order. */
  nested?: readonly ChatNode[];
  /** Renders one child. The caller passes it, so this file does not import the item renderer. */
  renderNested: (node: ChatNode) => ReactNode;
  /** A child inside a parent card: no border or background, so the children read as rows of the parent. */
  flat?: boolean;
  view: BackgroundView;
  /** Items shown with the history (see liveItems.ts). Only a child that arrived after them enters with motion. */
  history?: HistoryIds | null | undefined;
}

/**
 * Tool call: uma linha de resumo (status, título, arquivo, +/−). Aberto enquanto está em andamento; depois de
 * concluído recolhe sozinho, a não ser que o usuário tenha aberto ou fechado à mão. Um subagente (ou qualquer
 * tool call com trabalho em segundo plano ou filhos) mostra rótulo, tipo do agente, estado e quantas ações internas
 * tem; começa recolhido e abre para listar os filhos.
 */
export function ToolCard({ api, item, nested = NO_NODES, renderNested, flat = false, view, history }: ToolCardProps) {
  const { t } = useTranslation('chat');
  const background = item.background;
  const state = cardState(item, view);
  const backgroundStyle = background !== undefined || nested.length > 0;
  const collapsedByDefault = background?.kind === 'subagent' || nested.length > 0;
  const live = item.status === 'pending' || item.status === 'in_progress';
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? (live && !collapsedByDefault);
  const summary = useMemo(() => summarizeTool(item), [item]);
  const hasChanges = summary.added > 0 || summary.removed > 0;
  const tone = item.status === null ? 'text-muted-foreground' : STATUS_TONE[item.status];
  // The status text as the card first showed it: a later change cross-fades, the first value does not (history).
  const [initialStatusText] = useState(summary.statusText);
  const last = nested.at(-1);
  const lastTitle = last === undefined ? '' : titleOf(last);
  const innerCount = t('tool.innerActions', { count: nested.length });
  const rowHover = 'transition-colors duration-200 hover:bg-accent motion-reduce:transition-none';

  return (
    <details
      data-slot="tool-card"
      className={cn('group overflow-hidden', flat ? 'rounded-none' : 'rounded-xl border border-border bg-card')}
      open={open}
      onToggle={(event) => setChoice(event.currentTarget.open)}
    >
      {backgroundStyle ? (
        <summary
          data-slot="tool-summary"
          className={cn(
            'flex min-h-11 cursor-pointer list-none flex-col justify-center gap-0.5 px-3 py-2 [&::-webkit-details-marker]:hidden',
            rowHover,
          )}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <BackgroundStatus state={state} showText={state === 'unknown'} />
            <span data-slot="tool-title" className="min-w-0 flex-1 truncate text-[15px] font-medium">
              {background?.label ?? summary.title}
            </span>
            {background?.agentType !== undefined && (
              <Badge className="shrink-0 bg-muted font-normal text-muted-foreground">{background.agentType}</Badge>
            )}
            <ChevronDown className={CHEVRON_CLASS} aria-hidden="true" />
          </span>
          {last !== undefined && (
            <span data-slot="tool-inner-count" className="truncate pl-6 text-[13px] text-muted-foreground">
              {lastTitle === '' ? innerCount : t('tool.innerWithLast', { summary: innerCount, title: lastTitle })}
            </span>
          )}
        </summary>
      ) : (
        <summary
          data-slot="tool-summary"
          className={cn(
            'flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden',
            rowHover,
          )}
        >
          <Badge
            key={summary.statusText}
            className={cn(
              'bg-secondary font-semibold',
              tone,
              summary.statusText !== initialStatusText && 'animate-enter-scale motion-reduce:animate-none',
            )}
          >
            {summary.statusText}
          </Badge>
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 whitespace-nowrap">
            <span data-slot="tool-title" className="min-w-0 truncate font-mono text-sm font-semibold">
              {summary.title}
            </span>
            {summary.file !== null && (
              <span className="min-w-0 truncate font-mono text-[13px] text-muted-foreground">{summary.file}</span>
            )}
          </span>
          {hasChanges && (
            <span
              role="img"
              className="flex shrink-0 gap-1.5 font-mono text-[13px] tabular-nums"
              aria-label={`${t('tool.linesAdded', { count: summary.added })}, ${t('tool.linesRemoved', { count: summary.removed })}`}
            >
              <span className="text-success">+{summary.added}</span>
              <span className="text-destructive">−{summary.removed}</span>
            </span>
          )}
          <ChevronDown className={CHEVRON_CLASS} aria-hidden="true" />
        </summary>
      )}

      {/* Browsers hide a closed card's body, so the fade-in runs each time the card opens. */}
      <div className={cn('flex flex-col gap-2.5 px-3 pb-3 group-open:animate-enter motion-reduce:animate-none', flat && 'pb-1')}>
        {nested.length > 0 && (
          <ul data-slot="tool-inner" className="flex flex-col divide-y divide-border">
            {nested.map((child) => (
              <li
                key={child.item.id}
                data-item-id={child.item.id}
                className={cn(NESTED_FRAME_CLASS, arrivedLive(history, child.item.id) && 'animate-enter')}
              >
                {renderNested(child)}
              </li>
            ))}
          </ul>
        )}
        {background?.jobs !== undefined && <BackgroundJobRows jobs={background.jobs} parent={state} />}
        {item.locations.length > 0 && (
          <ul className="m-0 list-none font-mono text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
            {item.locations.map((location) => (
              <li key={location}>{location}</li>
            ))}
          </ul>
        )}
        {item.content.map((content, index) => (
          <ToolContentView key={index} api={api} content={content} />
        ))}
      </div>
    </details>
  );
}
