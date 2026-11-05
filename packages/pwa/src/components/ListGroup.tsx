import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Grupo de lista estilo iOS (inset): um fundo, linhas separadas por fio fino. Não é um cartão por linha:
 * `overflow-hidden` mantém o swipe e os cantos arredondados dentro do grupo.
 */
export function ListGroup({ children, label, className }: { children: ReactNode; label?: string | undefined; className?: string | undefined }) {
  return (
    <ul
      aria-label={label}
      className={cn('flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card', className)}
    >
      {children}
    </ul>
  );
}

/** Linha de texto do grupo: ocupa a largura toda, altura mínima de 56px. */
export const listRowClass = 'flex min-h-14 items-center gap-3 px-4 py-2.5';

/** Parte tocável da linha (abre a sessão, a pasta, o item). Estica e encolhe com o texto. */
export const listMainClass =
  'flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent disabled:pointer-events-none disabled:opacity-50';

/** Cabeçalho de seção: ícone + nome, em cinza. Opcionalmente uma ação à direita. */
export function SectionHeading({
  icon: Icon,
  id,
  children,
  action,
}: {
  icon: LucideIcon;
  id: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 pl-1">
      <h2 id={id} className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
        {children}
      </h2>
      {action}
    </div>
  );
}
