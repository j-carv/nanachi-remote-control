import { useState } from 'react';
import { Check, GitBranch, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GitBranchesRepo, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { useAsync } from '../useAsync.js';
import { branchTitle, dirtyFilesOf, dirtyPreview, filterBranches, sortBranches } from '../workspace/branches.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listRowClass, SectionHeading } from './ListGroup.js';

/** Quantos arquivos sujos a folha lista antes de "e mais N". */
const DIRTY_PREVIEW_MAX = 5;

interface BranchSwitcherProps {
  api: ApiClient;
  workspace: Workspace;
  /** Depois de trocar (ou criar) a branch: quem mostra o estado do workspace recarrega. */
  onSwitched(): void;
}

/**
 * Chip da branch atual, no cabeçalho do workspace. Toque abre a folha para trocar. Fora de um repositório git
 * (`isRepo: false`, ou se a consulta falhar) o chip some em silêncio, como a barra de informações.
 */
export function BranchSwitcher({ api, workspace, onSwitched }: BranchSwitcherProps) {
  const { t } = useTranslation('workspace');
  const git = useAsync(() => api.gitBranches(workspace.id), [api, workspace.id]);
  const [open, setOpen] = useState(false);
  const head = git.data;
  if (head === null || !head.isRepo) return null;
  const title = branchTitle(head);

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={t('branches.chip', { title })}
        onClick={() => setOpen(true)}
        className="-ml-1 flex min-h-11 max-w-full items-center self-start rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Badge variant="outline" className="h-7 max-w-full gap-1.5 px-2.5 font-mono text-xs text-foreground">
          <GitBranch aria-hidden="true" />
          <span className="truncate">{title}</span>
        </Badge>
      </button>
      {open && (
        <BranchSheet
          api={api}
          workspace={workspace}
          head={head}
          onClose={() => setOpen(false)}
          onSwitched={() => {
            setOpen(false);
            git.reload();
            onSwitched();
          }}
        />
      )}
    </>
  );
}

interface BranchSheetProps {
  api: ApiClient;
  workspace: Workspace;
  head: GitBranchesRepo;
  onClose(): void;
  onSwitched(): void;
}

/** Folha de branches: busca, lista por último commit, "Nova branch" e os erros da troca, todos aqui dentro. */
function BranchSheet({ api, workspace, head, onClose, onSwitched }: BranchSheetProps) {
  const { t } = useTranslation('workspace');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const branches = filterBranches(sortBranches(head.branches), query);
  const dirty = dirtyFilesOf(error);
  const preview = dirtyPreview(dirty, DIRTY_PREVIEW_MAX);

  async function switchTo(branch: string, create: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.gitCheckout(workspace.id, { branch, create });
      onSwitched();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('branches.switchTitle')}</DrawerTitle>
          <DrawerDescription className="sr-only">{t('branches.switchHint', { name: workspace.name })}</DrawerDescription>
        </DrawerHeader>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pt-3 pb-4">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              aria-label={t('branches.search')}
              placeholder={t('branches.search')}
              value={query}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="pl-10 wide:h-9"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          <ErrorNotice error={error} />
          {dirty.length > 0 && (
            <ul aria-label={t('branches.dirtyFiles')} className="flex flex-col gap-0.5 pl-1 font-mono text-sm text-muted-foreground">
              {preview.shown.map((path) => (
                <li key={path} className="truncate">
                  {path}
                </li>
              ))}
              {preview.hidden > 0 && <li>{t('branches.andMore', { count: preview.hidden })}</li>}
            </ul>
          )}

          <SectionHeading icon={GitBranch} id="branches-heading">
            {t('branches.local')}
          </SectionHeading>
          {branches.length === 0 && query.trim() !== '' && (
            <p className="pl-1 text-sm text-muted-foreground">{t('branches.noMatch')}</p>
          )}
          <ListGroup label={t('branches.local')}>
            {branches.map((branch) => (
              <li key={branch.name}>
                <button
                  type="button"
                  disabled={busy}
                  aria-current={branch.current ? 'true' : undefined}
                  onClick={() => (branch.current ? onClose() : void switchTo(branch.name, false))}
                  className={`${listRowClass} w-full text-left transition-colors hover:bg-accent active:bg-accent disabled:opacity-50 wide:min-h-10 wide:py-1.5`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-mono text-[15px] font-medium">{branch.name}</span>
                    {branch.upstream !== null && (
                      <span className="truncate font-mono text-xs text-muted-foreground">{branch.upstream}</span>
                    )}
                  </span>
                  {branch.current && <Check className="size-5 shrink-0" aria-hidden="true" />}
                </button>
              </li>
            ))}
            <li>
              {creating ? (
                <form
                  className="flex items-center gap-2 px-4 py-2.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const branch = newName.trim();
                    if (branch !== '' && !busy) void switchTo(branch, true);
                  }}
                >
                  <Input
                    autoFocus
                    aria-label={t('branches.newNameLabel')}
                    placeholder={t('branches.newNamePlaceholder')}
                    value={newName}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="font-mono wide:h-9"
                    onChange={(event) => setNewName(event.target.value)}
                  />
                  <Button type="submit" variant="secondary" size="compact" disabled={busy || newName.trim() === ''}>
                    {busy ? t('branches.creating') : t('branches.create')}
                  </Button>
                </form>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setCreating(true)}
                  className={`${listRowClass} w-full text-left transition-colors hover:bg-accent active:bg-accent disabled:opacity-50 wide:min-h-10 wide:py-1.5`}
                >
                  <Plus className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="text-base">{t('branches.new')}</span>
                </button>
              )}
            </li>
          </ListGroup>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
