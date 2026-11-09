import { useState } from 'react';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CommitEntry, Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { appendCommitPage, COMMITS_PAGE_SIZE } from '../commits.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton, listRowClass, listRowPressClass, staggerDelay } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Navigator } from '../navigation.js';
import { formatRelativeTime } from '../relativeTime.js';
import { useAsync } from '../useAsync.js';
import { workingTreeState, type WorkingTreeState } from '../workingTree.js';

interface CommitsScreenProps {
  machineName: string;
  workspace: Workspace;
  session: Session;
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

/** The pages after the first one: the commits "Carregar mais" added, and whether the daemon has yet more. */
interface MorePages {
  commits: CommitEntry[];
  hasMore: boolean;
}

/**
 * Histórico do branch da sessão (HEAD), do mais novo para o mais antigo, uma página por vez. Tocar num commit abre o
 * detalhe dele. "Atualizar" volta para a primeira página.
 */
export function CommitsScreen({ machineName, workspace, session, api, nav, onRepair }: CommitsScreenProps) {
  const { t } = useTranslation('workspace');
  const first = useAsync(
    () => api.sessionCommits(session.id, { skip: 0, limit: COMMITS_PAGE_SIZE }),
    [api, session.id],
  );
  // The workspace info counts the workspace folder. A worktree session has a folder of its own, which only its diff counts.
  const inWorktree = session.worktree !== null;
  const info = useAsync(() => api.workspaceInfo(workspace.id), [api, workspace.id]);
  // Loaded only for a worktree session: for the others `workingTreeState` counts the info and never reads this.
  const worktreeFiles = useAsync(
    () => (inWorktree ? api.sessionDiff(session.id).then((diff) => diff.files.length) : Promise.resolve(null)),
    [api, session.id, inWorktree],
  );
  const working = workingTreeState(session, info, worktreeFiles);
  const [more, setMore] = useState<MorePages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);

  const listed = appendCommitPage(first.data?.commits ?? [], more?.commits ?? []);
  const hasMore = more?.hasMore ?? first.data?.hasMore ?? false;
  const now = Date.now();

  function refresh() {
    setMore(null);
    setMoreError(null);
    first.reload();
    info.reload();
    worktreeFiles.reload();
  }

  async function loadMore() {
    setLoadingMore(true);
    setMoreError(null);
    try {
      // The offset is what the list shows: a commit that HEAD gained since the last page is dropped as a repeat.
      const page = await api.sessionCommits(session.id, { skip: listed.length, limit: COMMITS_PAGE_SIZE });
      setMore((current) => ({
        commits: appendCommitPage(current?.commits ?? [], page.commits),
        hasMore: page.hasMore,
      }));
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader
        title={t('commitsScreen.title')}
        subtitle={`${workspace.name} · ${machineName}`}
        onBack={() => nav.back()}
        actions={
          <Button variant="ghost" size="icon" aria-label={t('commitsScreen.refresh')} onClick={refresh}>
            <RefreshCw aria-hidden="true" />
          </Button>
        }
      />

      <ErrorNotice error={first.error} onRepair={onRepair} />

      <WorkingTreeRow state={working} workspace={workspace} session={session} nav={nav} />

      {first.data === null && first.error === null && <ListSkeleton label={t('states.loading', { ns: 'common' })} />}
      {first.data !== null && listed.length === 0 && (
        <p className="animate-enter pl-1 text-muted-foreground">{t('commitsScreen.empty')}</p>
      )}

      {listed.length > 0 && (
        <ListGroup label={t('commitsScreen.listLabel')}>
          {listed.map((commit, index) => (
            <li key={commit.hash} data-slot="commit-row" className="animate-enter flex flex-col" style={staggerDelay(index)}>
              <button
                type="button"
                className={cn(listRowClass, listRowPressClass)}
                onClick={() => nav.push({ kind: 'commit', workspace, session, hash: commit.hash })}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-medium">{commit.subject}</span>
                  {commit.summary !== null && (
                    <span className="truncate text-sm text-muted-foreground">{commit.summary}</span>
                  )}
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {`${commit.author} · ${formatRelativeTime(commit.date, now)} · ${commit.shortHash}`}
                  </span>
                </span>
                <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ListGroup>
      )}

      <ErrorNotice error={moreError} onRepair={onRepair} />

      {hasMore && (
        <Button variant="ghost" className="self-start text-muted-foreground" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t('states.loading', { ns: 'common' }) : t('commitsScreen.loadMore')}
        </Button>
      )}
    </Screen>
  );
}

interface WorkingTreeRowProps {
  state: WorkingTreeState;
  workspace: Workspace;
  session: Session;
  nav: Navigator;
}

/**
 * The first row of the commit history: the session's uncommitted work, which opens the changes (`git diff HEAD`). Shown
 * as a loading row until its count is known, and not at all for a folder that is not a git repository.
 */
export function WorkingTreeRow({ state, workspace, session, nav }: WorkingTreeRowProps) {
  const { t } = useTranslation('workspace');
  if (state.kind === 'hidden') return null;

  let detail: string | null = null;
  if (state.kind === 'loading') detail = t('states.loading', { ns: 'common' });
  else if (state.changedFiles === 0) detail = t('commitsScreen.noUncommitted');
  else if (state.changedFiles !== null) detail = t('commitsScreen.workingTreeChanges', { count: state.changedFiles });

  return (
    <ListGroup>
      <li data-slot="working-tree-row" className="animate-enter flex flex-col">
        <button
          type="button"
          className={cn(listRowClass, listRowPressClass)}
          onClick={() => nav.push({ kind: 'changes', workspace, session })}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-medium">{t('commitsScreen.workingTree')}</span>
            {detail !== null && <span className="truncate text-sm text-muted-foreground">{detail}</span>}
          </span>
          <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
        </button>
      </li>
    </ListGroup>
  );
}
