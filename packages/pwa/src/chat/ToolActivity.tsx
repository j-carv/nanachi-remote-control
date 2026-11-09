import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { BackgroundStatus } from './BackgroundStatus.js';
import type { BackgroundView } from './background.js';
import { arrivedLive, type HistoryIds } from './liveItems.js';
import type { ChatNode } from './nesting.js';
import { activitySegments, hasToolFailure, toolActivityState } from './activityGrouping.js';
import { summarizeTool, type ToolItem } from './toolSummary.js';
import { ITEM_FRAME_CLASS } from './itemFrame.js';
import { cn } from '@/lib/utils';

interface ToolActivityProps {
  nodes: readonly ChatNode[];
  view: BackgroundView;
  history?: HistoryIds | null | undefined;
  renderNode: (node: ChatNode) => ReactNode;
}

/** The first call owns the disclosure for its whole run, even as calls append or finish. */
export function ToolActivity({ nodes, view, history, renderNode }: ToolActivityProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const row = (node: ChatNode) => (
    <li key={node.item.id} data-item-id={node.item.id}
      className={cn(ITEM_FRAME_CLASS, arrivedLive(history, node.item.id) && 'animate-enter motion-reduce:animate-none')}>
      {renderNode(node)}
    </li>
  );

  return (
    <div data-slot="tool-activity-run" className="flex min-w-0 flex-col gap-3">
      {activitySegments(nodes).map((segment) => {
        const first = segment[0];
        if (first === undefined) return null;
        if (hasToolFailure(first)) {
          return <ul key={first.item.id} data-slot="tool-activity-exception" className="min-w-0">{row(first)}</ul>;
        }
        let current: ToolItem | undefined;
        let completed = true;
        for (const node of segment) {
          if (node.item.kind !== 'tool_call') continue;
          const state = toolActivityState(node.item, view);
          if (state === 'running') current = node.item;
          if (state !== 'completed') completed = false;
        }
        const state = current !== undefined ? 'running' : completed ? 'completed' : 'unknown';
        const summary = current === undefined ? null : summarizeTool(current);
        const title = current?.background?.label ?? summary?.title;
        const label = title === undefined
          ? t(completed ? 'tool.activityCompleted' : 'tool.activityActions', { count: segment.length })
          : t('tool.activityRunning', { title, summary: t('tool.activityActions', { count: segment.length }) });
        return (
          <details key={first.item.id} data-slot="tool-activity" className="group/activity min-w-0 overflow-hidden rounded-xl border border-border bg-card"
            open={open} onToggle={(event) => {
              if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
            }}>
            <summary data-slot="tool-activity-summary" aria-label={label}
              className="flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-accent motion-reduce:transition-none [&::-webkit-details-marker]:hidden">
              <BackgroundStatus state={state} />
              <span className="min-w-0 flex-1 truncate" title={label}>{title ?? label}</span>
              {current !== undefined && <span className="shrink-0 text-xs text-muted-foreground">{t('tool.activityActions', { count: segment.length })}</span>}
              {summary?.file !== null && summary?.file !== undefined && (
                <span className="max-w-[35%] truncate font-mono text-xs text-muted-foreground">{summary.file}</span>
              )}
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-open/activity:rotate-180 motion-reduce:transition-none" />
            </summary>
            <ul data-slot="tool-activity-rows" className="flex min-w-0 flex-col divide-y divide-border">{segment.map(row)}</ul>
          </details>
        );
      })}
    </div>
  );
}
