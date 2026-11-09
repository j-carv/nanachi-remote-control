import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton, listRowClass, listRowPressClass, staggerDelay } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { UnifiedPatchView } from '../components/UnifiedPatchView.js';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Navigator } from '../navigation.js';
import { formatRelativeTime } from '../relativeTime.js';
import { useAsync } from '../useAsync.js';

interface CommitScreenProps {
  machineName: string;
  workspace: Workspace;
  session: Session;
  /** Full hash of the commit, as the history list gave it. */
  hash: string;
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

/**
 * Um commit do histórico: assunto, mensagem completa, autor, data e hash. Os arquivos que ele mudou vêm com o status e
 * +/−; tocar num abre o patch dele logo abaixo, como nas alterações da sessão.
 */
export function CommitScreen({ machineName, workspace, session, hash, api, nav, onRepair }: CommitScreenProps) {
  const { t } = useTranslation('workspace');
  const commit = useAsync(() => api.sessionCommit(session.id, hash), [api, session.id, hash]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const detail = commit.data;
  const now = Date.now();

  return (
    <Screen>
      <ScreenHeader
        title={detail === null ? hash.slice(0, 7) : detail.subject || detail.shortHash}
        subtitle={`${workspace.name} · ${machineName}`}
        onBack={() => nav.back()}
      />

      <ErrorNotice error={commit.error} onRepair={onRepair} />

      {detail === null && commit.error === null && <ListSkeleton label={t('states.loading', { ns: 'common' })} />}

      {detail !== null && (
        <div className="animate-enter flex flex-col gap-3">
          <div className="flex flex-col gap-1 pl-1">
            <p className="text-sm text-muted-foreground">{`${detail.author} · ${formatRelativeTime(detail.date, now)}`}</p>
            <p className="font-mono text-xs break-all text-muted-foreground">{detail.hash}</p>
          </div>

          {detail.body.length > 0 && <p className="pl-1 text-sm whitespace-pre-wrap">{detail.body}</p>}

          {detail.truncated && (
            <p role="status" className="pl-1 text-sm text-muted-foreground">
              {t('commitScreen.truncated')}
            </p>
          )}

          {detail.files.length === 0 && <p className="pl-1 text-muted-foreground">{t('commitScreen.noFiles')}</p>}

          {detail.files.length > 0 && (
            <ListGroup label={t('commitScreen.filesLabel')}>
              {detail.files.map((file, index) => {
                const open = openPath === file.path;
                return (
                  <li
                    key={file.path}
                    data-slot="commit-file-row"
                    className="animate-enter flex flex-col"
                    style={staggerDelay(index)}
                  >
                    <button
                      type="button"
                      data-slot="commit-file-toggle"
                      aria-expanded={open}
                      className={cn(listRowClass, listRowPressClass)}
                      onClick={() => setOpenPath(open ? null : file.path)}
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{t(`changesScreen.status.${file.status}`)}</Badge>
                          <span className="font-mono text-sm font-medium tabular-nums">
                            +{file.additions} <span className="text-muted-foreground">−{file.deletions}</span>
                          </span>
                        </span>
                        <span className="truncate font-mono text-sm">{file.path}</span>
                      </span>
                      <ChevronDown
                        aria-hidden="true"
                        className={cn(
                          'size-5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                          open && 'rotate-180',
                        )}
                      />
                    </button>
                    {open && (
                      <div className="animate-enter px-4 pb-3">
                        <UnifiedPatchView patch={file.patch} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ListGroup>
          )}
        </div>
      )}
    </Screen>
  );
}
