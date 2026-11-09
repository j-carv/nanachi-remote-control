import { MessageSquareText } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Session, Workspace } from '@nanachi/shared';
import { cn } from '@/lib/utils';
import type { MessageSearchState } from '../useSessionMessageSearch.js';
import { ErrorNotice } from './ErrorNotice.js';
import { ListSkeleton } from './ListGroup.js';
import { formatRelativeTime } from '../relativeTime.js';

/** A message match ready to show: the session it belongs to, the label the list uses for it, and the matching snippet. */
export interface MessageMatchRow {
  workspace: Workspace;
  session: Session;
  label: string;
  snippet: string;
  matchedAt: number;
}

interface SessionMessageMatchesProps {
  state: MessageSearchState;
  rows: readonly MessageMatchRow[];
  /** Shows the workspace name under each row: the wide list mixes the sessions of several workspaces. */
  showWorkspace: boolean;
  selectedSessionId: string | null;
  /** Epoch ms for the relative time of each match. */
  now: number;
  onOpen(row: MessageMatchRow): void;
}

/**
 * The matches inside the messages of the sessions, under the sessions that match by name. Shows its own loading, error
 * and empty states; nothing at all while the query is too short to search.
 */
export function SessionMessageMatches({
  state,
  rows,
  showWorkspace,
  selectedSessionId,
  now,
  onOpen,
}: SessionMessageMatchesProps) {
  const { t } = useTranslation('common');
  const headingId = useId();
  if (state.status === 'idle') return null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1 pt-3">
      <h2 id={headingId} className="flex min-h-9 items-center gap-2 pl-2 text-sm font-medium text-muted-foreground">
        <MessageSquareText className="size-4" aria-hidden="true" />
        {t('search.messages')}
      </h2>
      {state.status === 'loading' && <ListSkeleton label={t('search.messagesLoading')} rows={2} />}
      {state.status === 'failed' && <ErrorNotice error={state.error} />}
      {state.status === 'ready' && rows.length === 0 && (
        <p className="px-2 py-1 text-sm text-muted-foreground">{t('search.messagesEmpty')}</p>
      )}
      {state.status === 'ready' && rows.length > 0 && (
        <ul aria-labelledby={headingId} className="flex flex-col gap-px">
          {rows.map((row) => {
            const selected = row.session.id === selectedSessionId;
            return (
              <li key={`${row.session.id}-${row.matchedAt}`}>
                <button
                  type="button"
                  data-slot="message-match"
                  data-session={row.session.id}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => onOpen(row)}
                  className={cn(
                    'flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-2 text-left outline-none transition-[background-color,scale] duration-200 ease-out-premium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99]',
                    selected && 'bg-accent',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{row.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatRelativeTime(row.matchedAt, now)}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-sm leading-5 text-muted-foreground">{row.snippet}</span>
                  {showWorkspace && <span className="truncate text-xs text-muted-foreground">{row.workspace.name}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
