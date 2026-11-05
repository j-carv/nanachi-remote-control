import { useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, ListSkeleton, listRowClass, listRowPressClass, staggerDelay } from '../components/ListGroup.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { UnifiedPatchView } from '../components/UnifiedPatchView.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';

interface ChangesScreenProps {
  machineName: string;
  workspace: Workspace;
  session: Session;
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

/**
 * Alterações da sessão (`git diff HEAD` no cwd dela). A lista mostra status e +/−; tocar num
 * arquivo abre o patch dele logo abaixo. "Atualizar" refaz a consulta.
 */
export function ChangesScreen({
  machineName,
  workspace,
  session,
  api,
  nav,
  onRepair,
}: ChangesScreenProps) {
  const { t } = useTranslation('workspace');
  const diff = useAsync(() => api.sessionDiff(session.id), [api, session.id]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const files = diff.data?.files ?? [];

  return (
    <Screen>
      <ScreenHeader
        title={t('changesScreen.title')}
        subtitle={`${workspace.name} · ${machineName}`}
        onBack={() => nav.back()}
        actions={
          <Button variant="ghost" size="icon" aria-label={t('changesScreen.refresh')} onClick={diff.reload}>
            <RefreshCw aria-hidden="true" />
          </Button>
        }
      />

      <ErrorNotice error={diff.error} onRepair={onRepair} />

      {diff.data?.truncated === true && (
        <p role="status" className="pl-1 text-sm text-muted-foreground">
          {t('changesScreen.truncated')}
        </p>
      )}

      {diff.data === null && diff.error === null && <ListSkeleton label={t('states.loading', { ns: 'common' })} />}
      {diff.data !== null && files.length === 0 && (
        <p className="animate-enter pl-1 text-muted-foreground">{t('changesScreen.empty')}</p>
      )}

      {files.length > 0 && (
        <ListGroup label={t('changesScreen.listLabel')}>
          {files.map((file, index) => {
            const open = openPath === file.path;
            return (
              <li
                key={file.path}
                data-slot="change-row"
                className="animate-enter flex flex-col"
                style={staggerDelay(index)}
              >
                <button
                  type="button"
                  data-slot="change-toggle"
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
    </Screen>
  );
}
