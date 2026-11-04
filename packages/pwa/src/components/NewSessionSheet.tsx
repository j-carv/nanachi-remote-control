import { useState } from 'react';
import type { ConfigValue, Session, SessionConfigOption, Workspace } from '@nanachi/shared';
import {
  applyConfigValue,
  readAgentConfig,
  toCreateConfig,
  writeAgentConfig,
} from '../agentConfig.js';
import type { ApiClient } from '../api.js';
import type { StorageLike } from '../machines.js';
import { useAsync } from '../useAsync.js';
import { ConfigControls } from './ConfigControls.js';
import { ErrorNotice } from './ErrorNotice.js';

interface NewSessionSheetProps {
  api: ApiClient;
  storage: StorageLike;
  workspace: Workspace;
  /** Agente já marcado ao abrir (ex.: o da sessão atual). Se não existir mais, cai no primeiro. */
  initialAgentId?: string | undefined;
  onCreated(session: Session): void;
  onClose(): void;
}

/**
 * Folha de nova sessão: escolhe o agente e mostra as opções lembradas da última sessão
 * daquele agente (localStorage). Essas opções são enviadas em `config` ao criar.
 */
export function NewSessionSheet({
  api,
  storage,
  workspace,
  initialAgentId,
  onCreated,
  onClose,
}: NewSessionSheetProps) {
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, SessionConfigOption[]>>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [worktree, setWorktree] = useState(false);
  // Worktree só existe em repositório git (branch no /info). Falha do /info: some em silêncio.
  const info = useAsync(() => api.workspaceInfo(workspace.id), [api, workspace.id]);
  const isGit = info.data !== null && info.data.branch !== null;

  const agentList = agents.data ?? [];
  const agentId =
    chosen ??
    agentList.find((agent) => agent.id === initialAgentId)?.id ??
    agentList[0]?.id ??
    null;
  // Terminal (PTY) não tem opções de agente: nada de seletores nem `config` na criação.
  const isTerminal = agentList.find((agent) => agent.id === agentId)?.kind === 'pty';
  const options =
    agentId === null || isTerminal ? [] : (edits[agentId] ?? readAgentConfig(storage, agentId));
  const error = createError ?? agents.error;

  function change(configId: string, value: ConfigValue) {
    if (agentId === null) return;
    setEdits((previous) => ({ ...previous, [agentId]: applyConfigValue(options, configId, value) }));
  }

  async function create() {
    if (agentId === null || creating) return;
    setCreating(true);
    setCreateError(null);
    if (options.length > 0) writeAgentConfig(storage, agentId, options);
    try {
      const session = await api.createSession({
        workspaceId: workspace.id,
        agent: agentId,
        ...(options.length > 0 ? { config: toCreateConfig(options) } : {}),
        ...(worktree && isGit ? { worktree: true } : {}),
      });
      onCreated(session);
    } catch (caught) {
      setCreateError(caught);
      setCreating(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Nova sessão"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="section-title">Nova sessão</h2>
        <p className="muted small">{workspace.name}</p>

        <ErrorNotice error={error} />

        <fieldset className="agent-picker">
          <legend className="section-title">Agente</legend>
          {agentList.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="agent-choice"
              aria-pressed={agent.id === agentId}
              onClick={() => setChosen(agent.id)}
            >
              {agent.label}
              {agent.kind === 'pty' && <span className="badge agent-kind">terminal</span>}
            </button>
          ))}
          {agents.data !== null && agentList.length === 0 && (
            <p className="muted small">Nenhum agente configurado no daemon.</p>
          )}
        </fieldset>

        {isGit && (
          <label className="config-toggle">
            <span>
              <span className="config-name">Em worktree separado</span>
              <span className="muted small">
                Cria um branch e uma pasta próprios para esta sessão; o seu checkout fica intacto.
              </span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={worktree}
              onChange={(event) => setWorktree(event.target.checked)}
            />
          </label>
        )}

        {!isTerminal && (
          <>
            <h3 className="section-title">Opções</h3>
            {options.length > 0 ? (
              <ConfigControls options={options} onChange={change} />
            ) : (
              <p className="muted small">
                Ainda sem opções lembradas para este agente. Elas aparecem no chat depois da primeira
                sessão e passam a ser usadas aqui.
              </p>
            )}
          </>
        )}

        <div className="sheet-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="button primary"
            disabled={agentId === null || creating}
            onClick={() => void create()}
          >
            {creating ? 'Criando…' : 'Criar sessão'}
          </button>
        </div>
      </section>
    </div>
  );
}
