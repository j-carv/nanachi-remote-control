import type { LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
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
  'flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none transition-[background-color,scale] duration-200 ease-out-premium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50';

/** A whole row that is a button (`listRowClass` plus this): the hover and press colour ease, and the press scales a little. */
export const listRowPressClass =
  'w-full text-left transition-[background-color,scale] duration-200 ease-out-premium hover:bg-accent active:bg-accent active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50';

/** Items of a list fade in one after another: 30 ms apart, and the first eight only, so a long list does not wait. */
export function staggerDelay(index: number): CSSProperties {
  return { animationDelay: `${Math.min(index, 8) * 30}ms` };
}

/**
 * Placeholder rows while a list loads: shimmering bars in the shape of a row. The label is for screen readers; the bars
 * are decorative.
 */
export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div data-slot="list-skeleton" className="overflow-hidden rounded-xl border border-border bg-card">
      <p className="sr-only">{label}</p>
      <div aria-hidden="true" className="flex flex-col divide-y divide-border">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className={listRowClass}>
            <span className="size-5 shrink-0 rounded-md animate-shimmer" />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="h-3.5 w-3/5 rounded animate-shimmer" />
              <span className="h-3 w-2/5 rounded animate-shimmer" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

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
