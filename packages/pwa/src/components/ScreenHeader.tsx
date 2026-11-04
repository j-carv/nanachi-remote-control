import type { ReactNode } from 'react';
import { CaretLeft } from '@phosphor-icons/react';

interface ScreenHeaderProps {
  title: string;
  subtitle?: string | undefined;
  /** Linha extra abaixo do subtítulo (ex.: chip do branch do worktree). */
  meta?: ReactNode;
  onBack?: (() => void) | undefined;
  actions?: ReactNode;
}

/** Cabeçalho das telas internas: botão voltar (alvo de 44px) + título. */
export function ScreenHeader({ title, subtitle, meta, onBack, actions }: ScreenHeaderProps) {
  return (
    <header className="app-header">
      {onBack !== undefined && (
        <button type="button" className="icon-button" onClick={onBack} aria-label="Voltar">
          <CaretLeft size={26} weight="regular" aria-hidden="true" />
        </button>
      )}
      <div className="app-header-text">
        <h1 className="app-title">{title}</h1>
        {subtitle !== undefined && <p className="muted small">{subtitle}</p>}
        {meta}
      </div>
      {actions !== undefined && <div className="app-header-actions">{actions}</div>}
    </header>
  );
}
