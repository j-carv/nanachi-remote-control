import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { AvailableCommand } from '@nanachi/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  const { t } = useTranslation('chat');
  const matches = filterCommands(commands, query);
  // Mousedown com preventDefault: o campo (ou a busca) mantém o foco e o teclado não fecha.
  const keepFocus = (event: MouseEvent) => event.preventDefault();

  return (
    <section
      data-slot="slash-menu"
      aria-label={t('slash.label')}
      className="flex animate-enter flex-col gap-1 rounded-xl border border-border bg-card p-1.5 motion-reduce:animate-none"
    >
      {search !== undefined && (
        <div className="flex items-center gap-1">
          <Input
            type="search"
            aria-label={t('slash.search')}
            placeholder={t('slash.search')}
            autoFocus
            value={query}
            className="bg-background"
            onChange={(event) => search.onChange(event.target.value)}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('slash.close')}
            onMouseDown={keepFocus}
            onClick={search.onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}

      <div className="max-h-[min(40dvh,240px)] overflow-y-auto overscroll-contain">
        {commands.length === 0 ? (
          <p data-slot="slash-empty" className="px-2 py-2.5 text-sm text-muted-foreground">
            {t('slash.none')}
          </p>
        ) : matches.length === 0 ? (
          <p data-slot="slash-empty" className="px-2 py-2.5 text-sm text-muted-foreground">
            {t('slash.noMatch', { query: query.trim() })}
          </p>
        ) : (
          <ul className="flex flex-col">
            {matches.map((command) => (
              <li key={command.name}>
                <button
                  type="button"
                  data-slot="slash-item"
                  onMouseDown={keepFocus}
                  onClick={() => onPick(command)}
                  className="flex min-h-11 w-full flex-col items-start justify-center gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] active:bg-accent motion-reduce:active:scale-100"
                >
                  <span className="flex max-w-full min-w-0 items-baseline gap-2">
                    <span data-slot="slash-name" className="shrink-0 font-mono text-sm font-semibold">
                      /{command.name}
                    </span>
                    {command.hint !== null && (
                      <span data-slot="slash-hint" className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                        {command.hint}
                      </span>
                    )}
                  </span>
                  <span data-slot="slash-desc" className="max-w-full truncate text-sm text-muted-foreground">
                    {command.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
