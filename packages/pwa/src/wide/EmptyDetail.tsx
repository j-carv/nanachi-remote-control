import { FolderOpen, FolderPlus, Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { ConnectionStatus } from '../connection.js';
import type { WorkspaceNode } from './sessionTree.js';

interface EmptyDetailProps {
  status: ConnectionStatus;
  /** Null until the machine's first load answers. */
  nodes: readonly WorkspaceNode[] | null;
  onOpenWorkspaces(): void;
  onAddWorkspace(): void;
  onRepair(): void;
}

/**
 * The right pane before anything is picked (the first screen of the stack, "home"): the phone's home is the list
 * itself, which the wide layout keeps on the left, so this says what to do next.
 */
export function EmptyDetail({ status, nodes, onOpenWorkspaces, onAddWorkspace, onRepair }: EmptyDetailProps) {
  const { t } = useTranslation('wide');
  const unauthorized = status === 'unauthorized';
  const noWorkspaces = nodes !== null && nodes.length === 0;

  return (
    <div data-slot="empty-detail" className="relative flex h-full min-h-[24rem] flex-col items-center justify-center px-8 text-center">
      {/* The app icon is black on black: in light mode it is inverted so the figure reads as a faint dark mark. The blend
          modes drop the icon's own square background, so only the figure shows. */}
      <img
        src="/icon-512.png"
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute top-1/2 left-1/2 -z-10 w-[min(60%,380px)] -translate-x-1/2 -translate-y-1/2 select-none opacity-[0.05] mix-blend-darken invert dark:opacity-[0.08] dark:mix-blend-lighten dark:invert-0"
      />
      <h1 className="text-xl font-semibold tracking-tight">{t('empty.title')}</h1>
      <p className="mt-2 max-w-sm text-base leading-6 text-muted-foreground">
        {unauthorized ? t('empty.unauthorized') : noWorkspaces ? t('empty.noWorkspaces') : t('empty.hint')}
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {unauthorized ? (
          <Button onClick={onRepair}>
            <Link2 aria-hidden="true" />
            {t('actions.pairAgain', { ns: 'common' })}
          </Button>
        ) : noWorkspaces ? (
          <Button onClick={onAddWorkspace}>
            <FolderPlus aria-hidden="true" />
            {t('workspaces.add', { ns: 'workspace' })}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onOpenWorkspaces}>
            <FolderOpen aria-hidden="true" />
            {t('main.workspaces', { ns: 'machines' })}
          </Button>
        )}
      </div>
    </div>
  );
}
