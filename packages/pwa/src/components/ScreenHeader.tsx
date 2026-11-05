import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface ScreenHeaderProps {
  title: string;
  subtitle?: string | undefined;
  /** Linha extra abaixo do subtítulo (ex.: chip do branch do worktree). */
  meta?: ReactNode;
  onBack?: (() => void) | undefined;
  actions?: ReactNode;
}

/**
 * Cabeçalho das telas: voltar (chevron, 44px) à esquerda, título e subtítulo, ações (ícones) à direita.
 * Rola com a tela, não é fixo.
 */
export function ScreenHeader({ title, subtitle, meta, onBack, actions }: ScreenHeaderProps) {
  const { t } = useTranslation();
  return (
    <header className="flex min-h-11 items-center gap-1">
      {onBack !== undefined && (
        <Button variant="ghost" size="icon" className="-ml-2" onClick={onBack} aria-label={t('actions.back')}>
          <ChevronLeft className="size-6" aria-hidden="true" />
        </Button>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-1">
        <h1 className="truncate text-xl leading-7 font-semibold tracking-tight">{title}</h1>
        {subtitle !== undefined && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
        {meta}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}
