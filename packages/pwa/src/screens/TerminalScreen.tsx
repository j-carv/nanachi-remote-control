import { useEffect, useState, type FormEvent } from 'react';
import { GitBranch } from '@phosphor-icons/react';
import type { Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { useVisualViewport } from '../components/useVisualViewport.js';
import type { Connection } from '../connection.js';
import type { Navigator } from '../navigation.js';
import { sessionTitle } from '../sessionText.js';
import { lineInput } from '../terminal/input.js';
import { TERMINAL_KEYS } from '../terminal/keys.js';
import { useTerminal, type CopyResult } from '../terminal/useTerminal.js';
import { useAsync } from '../useAsync.js';

interface TerminalScreenProps {
  machineName: string;
  workspace: Workspace;
  session: Session;
  api: ApiClient;
  connection: Connection | undefined;
  nav: Navigator;
  onRepair(): void;
}

const COPY_TEXT: Record<CopyResult, string> = {
  copied: 'Copiado.',
  empty: 'Selecione um trecho do terminal para copiar.',
  failed: 'Não consegui copiar. Tente de novo.',
};

function exitText(exitCode: number | null): string {
  return exitCode === null ? 'Processo encerrado (sem código)' : `Processo encerrado (código ${exitCode})`;
}

/**
 * Sessão de agente em modo terminal (PTY): o xterm ocupa a tela; embaixo, a barra de teclas
 * do celular e uma linha de texto. Cabeçalho igual ao do chat (voltar, título, status).
 */
export function TerminalScreen({
  machineName,
  workspace,
  session,
  api,
  connection,
  nav,
  onRepair,
}: TerminalScreenProps) {
  const terminal = useTerminal({ api, connection, session });
  const current = terminal.session;
  const agents = useAsync(() => api.fetchAgents(), [api]);
  const agentLabel = agents.data?.find((agent) => agent.id === current.agent)?.label ?? current.agent;
  const viewport = useVisualViewport();
  const { requestFit, input, inputOpen } = terminal;
  const [line, setLine] = useState('');
  const [copyNote, setCopyNote] = useState<string | null>(null);

  // Teclado do iOS e rotação mudam a área visível: refaz o fit (com debounce no hook).
  useEffect(() => {
    requestFit();
  }, [viewport, requestFit]);

  function submitLine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inputOpen) return;
    if (input(lineInput(line))) setLine('');
  }

  async function copy() {
    setCopyNote(COPY_TEXT[await terminal.copySelection()]);
  }

  const boxStyle = viewport === null ? undefined : { top: viewport.top, height: viewport.height };

  return (
    <div className="chat-screen terminal-screen" style={boxStyle}>
      <div className="chat-inner">
        <ScreenHeader
          title={sessionTitle(current, agentLabel)}
          subtitle={`${workspace.name} · ${machineName}`}
          meta={
            current.worktree === null ? null : (
              <span className="chip chip-branch">
                <GitBranch size={14} weight="bold" aria-hidden="true" />
                {current.worktree.branch}
              </span>
            )
          }
          onBack={() => nav.back()}
          actions={
            <>
              <SessionStatusPill status={current.status} kind="pty" />
              <button
                type="button"
                className="button secondary header-button"
                onClick={() => nav.push({ kind: 'changes', workspace, session: current })}
              >
                Alterações
              </button>
            </>
          }
        />

        <ErrorNotice error={terminal.loadError} onRepair={onRepair} />

        {terminal.notice !== null && (
          <div className="notice" role="status">
            <p>{terminal.notice}</p>
            <button type="button" className="button ghost" onClick={terminal.dismissNotice}>
              OK
            </button>
          </div>
        )}

        {terminal.exit !== null && (
          <p className="terminal-exit" role="status">
            {exitText(terminal.exit.exitCode)}
          </p>
        )}

        {!terminal.loaded && terminal.loadError === null && (
          <p className="muted small">Carregando terminal…</p>
        )}

        <div className="terminal-view" ref={terminal.setContainer} />

        <div className="terminal-bar">
          <div className="terminal-keys" role="toolbar" aria-label="Teclas especiais">
            {TERMINAL_KEYS.map((key) => (
              <button
                key={key.id}
                type="button"
                className="terminal-key"
                aria-label={key.ariaLabel}
                disabled={!inputOpen}
                onClick={() => input(key.data)}
              >
                {key.label}
              </button>
            ))}
          </div>
        </div>

        {copyNote !== null && (
          <p className="muted small" role="status">
            {copyNote}
          </p>
        )}

        <form className="chat-input" onSubmit={submitLine}>
          <input
            type="text"
            className="terminal-line"
            value={line}
            placeholder={inputOpen ? 'Texto para o terminal' : 'Terminal encerrado'}
            disabled={!inputOpen}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="send"
            onChange={(event) => setLine(event.target.value)}
          />
          <button
            type="button"
            className="button secondary terminal-copy"
            onClick={() => void copy()}
          >
            Copiar
          </button>
          <button type="submit" className="button primary" disabled={!inputOpen}>
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
