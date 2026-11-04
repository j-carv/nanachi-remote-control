import { useEffect, useState } from 'react';
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
import { ErrorNotice } from './ErrorNotice.js';

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
    <div className="sheet-backdrop" onClick={close}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Retomar do PC"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="section-title">Retomar do PC</h2>
        <p className="muted small">{workspace.name} · sessões criadas no terminal desta pasta</p>

        <ErrorNotice error={shownError} />

        <fieldset className="agent-picker">
          <legend className="section-title">Agente</legend>
          {resumable.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="agent-choice"
              aria-pressed={agent.id === chosen}
              disabled={importing}
              onClick={() => setChosen(agent.id)}
            >
              {agent.label}
            </button>
          ))}
          {agents.data !== null && resumable.length === 0 && (
            <p className="muted small">Nenhum agente de chat configurado no daemon.</p>
          )}
        </fieldset>

        {chosen !== null && (
          <>
            {importing && <p className="muted">{IMPORTING_TEXT}</p>}
            {loadingFirst && <p className="muted">{listingText(chosenLabel)}</p>}
            {listing !== null && !listing.supported && (
              <p className="muted">Este agente não lista sessões.</p>
            )}
            {listing !== null && listing.supported && listing.items.length === 0 && (
              <p className="muted">Nenhuma sessão deste agente nesta pasta.</p>
            )}
            {listing !== null && listing.items.length > 0 && (
              <ul className="item-list">
                {listing.items.map((item) => {
                  const age = sessionAgeText(item.updatedAt, now);
                  return (
                    <li key={item.acpSessionId} className="item-row">
                      <button
                        type="button"
                        className="item-main"
                        disabled={importing}
                        onClick={() => void importItem(item)}
                      >
                        <span className="item-title">{listedTitle(item)}</span>
                        <span className="item-meta">
                          {item.linkedSessionId !== null && <span className="chip">já no app</span>}
                          {age !== null && <span className="muted small">{age}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {listing !== null && listing.nextCursor !== null && (
              <button
                type="button"
                className="button secondary"
                disabled={loadingMore || importing}
                onClick={() => void loadMore()}
              >
                {loadingMore ? 'Carregando…' : 'Carregar mais'}
              </button>
            )}
          </>
        )}

        <div className="sheet-actions">
          <button type="button" className="button ghost" onClick={close} disabled={importing}>
            Fechar
          </button>
        </div>
      </section>
    </div>
  );
}
