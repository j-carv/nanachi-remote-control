import type { MouseEvent } from 'react';
import { X } from '@phosphor-icons/react';
import type { AvailableCommand } from '@nanachi/shared';
import { filterCommands } from './commands.js';

interface SlashMenuProps {
  /** Todos os comandos que o agente anunciou para a sessão. */
  commands: readonly AvailableCommand[];
  /** Busca atual: vem do texto (`/bus`) ou do campo do menu aberto pelo botão. */
  query: string;
  /** Campo de busca no topo (menu aberto pelo botão `/`). Sem ele, a busca é o próprio texto do composer. */
  search?: { onChange(query: string): void; onClose(): void } | undefined;
  onPick(command: AvailableCommand): void;
}

/**
 * Menu de comandos acima do composer (no fluxo da coluna, então não cobre o campo). Rolagem própria; o toque
 * não tira o foco do campo, assim o teclado do iOS continua aberto.
 */
export function SlashMenu({ commands, query, search, onPick }: SlashMenuProps) {
  const matches = filterCommands(commands, query);
  // Mousedown com preventDefault: o campo (ou a busca) mantém o foco e o teclado não fecha.
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <section className="slash-menu" aria-label="Comandos do agente">
      {search !== undefined && (
        <div className="slash-head">
          <input
            type="search"
            className="slash-search"
            aria-label="Buscar comando"
            placeholder="Buscar comando"
            autoFocus
            value={query}
            onChange={(event) => search.onChange(event.target.value)}
          />
          <button
            type="button"
            className="icon-button slash-close"
            aria-label="Fechar comandos"
            onMouseDown={keepFocus}
            onClick={search.onClose}
          >
            <X size={20} weight="regular" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="slash-scroll">
        {commands.length === 0 ? (
          <p className="muted slash-empty">Este agente não anunciou comandos.</p>
        ) : matches.length === 0 ? (
          <p className="muted slash-empty">Nenhum comando combina com “{query.trim()}”.</p>
        ) : (
          <ul className="slash-list">
            {matches.map((command) => (
              <li key={command.name}>
                <button
                  type="button"
                  className="slash-item"
                  onMouseDown={keepFocus}
                  onClick={() => onPick(command)}
                >
                  <span className="slash-line">
                    <span className="slash-name">/{command.name}</span>
                    {command.hint !== null && <span className="slash-hint">{command.hint}</span>}
                  </span>
                  <span className="slash-desc">{command.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
