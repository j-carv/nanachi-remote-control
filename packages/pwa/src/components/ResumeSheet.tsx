import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import type { AgentSessionSummary, Session, Workspace } from '@nanachi/shared';
import { ApiError, type ApiClient } from '../api.js';
import {
  appendListing,
  conflictSessionId,
  IMPORTING_TEXT,
  listedTitle,
  listingText,
  resumableAgents,
  sessionAgeText,
} from '../resume.js';
import { useAsync } from '../useAsync.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { ErrorNotice } from './ErrorNotice.js';
import { ListGroup, listMainClass, listRowClass } from './ListGroup.js';

interface ResumeSheetProps {
  api: ApiClient;
  workspace: Workspace;
  /** Abre a sessão no chat: a importada agora, ou a já ligada quando a importação responde 409. */
  onOpen(session: Session): void;
  onClose(): void;
}

/** Página acumulada da listagem do agente escolhido. `agentId` evita juntar página de outro agente. */
interface Listing {
  agentId: string;
  supported: boolean;
  items: AgentSessionSummary[];
  nextCursor: string | null;
}

/**
 * Folha "Retomar do PC": escolhe um agente de chat, lista as sessões que ele tem para a pasta do
 * workspace e importa a que o usuário tocar. Quem já está no app aparece com o selo "já no app".
 */
export function ResumeSheet({ api, workspace, onOpen, onClose }: ResumeSheetProps) {
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const resumable = resumableAgents(agents.data ?? []);
  const [chosen, setChosen] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadingFirst, setLoadingFirst] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const chosenLabel = resumable.find((agent) => agent.id === chosen)?.label ?? chosen ?? '';
  const now = Date.now();

  // Trocar de agente recarrega a lista; resposta de um agente anterior é descartada.
  useEffect(() => {
    if (chosen === null) return;
    let active = true;
    setListing(null);
    setError(null);
    setLoadingFirst(true);
    api.agentSessions(workspace.id, chosen).then(
      (page) => {
        if (!active) return;
        setListing({
          agentId: chosen,
          supported: page.supported,
          items: page.sessions,
          nextCursor: page.nextCursor,
        });
        setLoadingFirst(false);
      },
      (caught: unknown) => {
        if (!active) return;
        setError(caught);
        setLoadingFirst(false);
      },
    );
    return () => {
      active = false;
    };
  }, [api, workspace.id, chosen]);

  async function loadMore() {
    if (listing === null || listing.nextCursor === null || loadingMore) return;
    const { agentId } = listing;
    const cursor = listing.nextCursor;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.agentSessions(workspace.id, agentId, cursor);
      setListing((previous) =>
        previous === null || previous.agentId !== agentId
          ? previous
          : {
              agentId,
              supported: page.supported,
              items: appendListing(previous.items, page.sessions),
              nextCursor: page.nextCursor,
            },
      );
    } catch (caught) {
      setError(caught);
    } finally {
      setLoadingMore(false);
    }
  }

  async function openLinked(sessionId: string) {
    try {
      const sessions = await api.listSessions(workspace.id);
      const session = sessions.find((item) => item.id === sessionId);
      if (session === undefined) throw new ApiError('not_found', null);
      onOpen(session);
    } catch (caught) {
      setError(caught);
      setImporting(false);
    }
  }

  async function importItem(item: AgentSessionSummary) {
    if (chosen === null || importing) return;
    setImporting(true);
    setError(null);
    try {
      const session = await api.createSession({
        workspaceId: workspace.id,
        agent: chosen,
        resumeAcpSessionId: item.acpSessionId,
        resumeTitle: listedTitle(item),
      });
      onOpen(session);
    } catch (caught) {
      const linked = conflictSessionId(caught);
      if (linked === null) {
        setError(caught);
        setImporting(false);
        return;
      }
      await openLinked(linked);
    }
  }

  function close() {
    if (!importing) onClose();
  }

  const shownError = error ?? agents.error;

  return (
    <Drawer
      open
      dismissible={!importing}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Retomar do PC</DrawerTitle>
          <DrawerDescription>{workspace.name} · sessões criadas no terminal desta pasta</DrawerDescription>
        </DrawerHeader>

        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 pt-4 pb-2">
          <ErrorNotice error={shownError} />

          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 pl-1 text-sm font-medium text-muted-foreground">Agente</legend>
            <ListGroup>
              {resumable.map((agent) => {
                const pressed = agent.id === chosen;
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      aria-pressed={pressed}
                      disabled={importing}
                      className={cn(
                        listRowClass,
                        'w-full text-left text-base transition-colors hover:bg-accent active:bg-accent disabled:pointer-events-none disabled:opacity-50',
                      )}
                      onClick={() => setChosen(agent.id)}
                    >
                      <span className="min-w-0 flex-1 truncate">{agent.label}</span>
                      {pressed && <Check className="size-5 shrink-0" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ListGroup>
            {agents.data !== null && resumable.length === 0 && (
              <p className="pl-1 text-sm text-muted-foreground">Nenhum agente de chat configurado no daemon.</p>
            )}
          </fieldset>

          {chosen !== null && (
            <div className="flex flex-col gap-3">
              {importing && <p className="pl-1 text-sm text-muted-foreground">{IMPORTING_TEXT}</p>}
              {loadingFirst && <p className="pl-1 text-sm text-muted-foreground">{listingText(chosenLabel)}</p>}
              {listing !== null && !listing.supported && (
                <p className="pl-1 text-sm text-muted-foreground">Este agente não lista sessões.</p>
              )}
              {listing !== null && listing.supported && listing.items.length === 0 && (
                <p className="pl-1 text-sm text-muted-foreground">Nenhuma sessão deste agente nesta pasta.</p>
              )}
              {listing !== null && listing.items.length > 0 && (
                <ListGroup label="Sessões do PC">
                  {listing.items.map((item) => {
                    const age = sessionAgeText(item.updatedAt, now);
                    return (
                      <li key={item.acpSessionId} className={listRowClass}>
                        <button
                          type="button"
                          className={listMainClass}
                          disabled={importing}
                          onClick={() => void importItem(item)}
                        >
                          <span className="flex min-w-0 flex-1 flex-col gap-1">
                            <span className="truncate text-base">{listedTitle(item)}</span>
                            <span className="flex flex-wrap items-center gap-2">
                              {item.linkedSessionId !== null && <Badge>já no app</Badge>}
                              {age !== null && <span className="text-sm text-muted-foreground">{age}</span>}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ListGroup>
              )}
              {listing !== null && listing.nextCursor !== null && (
                <Button
                  variant="secondary"
                  disabled={loadingMore || importing}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? 'Carregando…' : 'Carregar mais'}
                </Button>
              )}
            </div>
          )}
        </div>

        <DrawerFooter className="flex-row">
          <Button variant="ghost" className="flex-1" onClick={close} disabled={importing}>
            Fechar
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
