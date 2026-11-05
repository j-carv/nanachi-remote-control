import { useState } from 'react';
import { Check, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Session, ShellId, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { useAsync } from '../useAsync.js';
import { orderShells } from '../shells.js';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listRowClass } from './ListGroup.js';

interface ShellSheetProps {
  api: ApiClient;
  workspace: Workspace;
  onCreated(session: Session): void;
  onClose(): void;
}

/**
 * Folha "Terminal": lista os shells que este PC tem. O padrão vem primeiro e marcado. Tocar num shell abre o
 * terminal na pasta do workspace (a sessão já nasce rodando, sem perguntar mais nada).
 */
export function ShellSheet({ api, workspace, onCreated, onClose }: ShellSheetProps) {
  const { t } = useTranslation('terminal');
  const shells = useAsync(() => api.fetchShells(), [api]);
  const [creating, setCreating] = useState<ShellId | null>(null);
  const [createError, setCreateError] = useState<unknown>(null);
  const ordered = orderShells(shells.data ?? []);
  const error = createError ?? shells.error;

  async function create(shell: ShellId) {
    if (creating !== null) return;
    setCreating(shell);
    setCreateError(null);
    try {
      const session = await api.createSession({ workspaceId: workspace.id, agent: 'shell', shell });
      onCreated(session);
    } catch (caught) {
      setCreateError(caught);
    } finally {
      setCreating(null);
    }
  }

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent size="sm">
        <DrawerHeader>
          <DrawerTitle>{t('shellSheet.title')}</DrawerTitle>
          <DrawerDescription>{t('shellSheet.hint', { name: workspace.name })}</DrawerDescription>
        </DrawerHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-5 pt-4 pb-[max(env(safe-area-inset-bottom),16px)]">
          <ErrorNotice error={error} />

          {shells.data !== null && shells.error === null && ordered.length === 0 && (
            <p className="text-muted-foreground">{t('shellSheet.none')}</p>
          )}

          {ordered.length > 0 && (
            <ListGroup label={t('shellSheet.listLabel')}>
              {ordered.map((shell) => (
                <li key={shell.id}>
                  <button
                    type="button"
                    data-slot="shell-option"
                    data-shell={shell.id}
                    className={`${listRowClass} w-full text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent disabled:pointer-events-none disabled:opacity-50 wide:min-h-10 wide:py-1.5`}
                    disabled={creating !== null}
                    onClick={() => void create(shell.id)}
                  >
                    <SquareTerminal className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="text-base">{shell.label}</span>
                      {shell.isDefault && <span className="text-sm text-muted-foreground">{t('shellSheet.default')}</span>}
                    </span>
                    {shell.isDefault && <Check className="size-5 shrink-0 text-foreground" aria-hidden="true" />}
                    {creating === shell.id && <span className="text-sm text-muted-foreground">{t('shellSheet.opening')}</span>}
                  </button>
                </li>
              ))}
            </ListGroup>
          )}

          <Button variant="ghost" size="wide" className="wide:h-9 wide:w-auto wide:self-end" onClick={onClose}>
            {t('actions.cancel', { ns: 'common' })}
          </Button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
