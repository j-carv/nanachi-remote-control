import type { ReactNode } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useBackAffordance } from '../wide/layoutContext.js';

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
  // Phone: the chevron. Next to the list pane a screen reached from the list has no "back"; the screens of the third pane
  // close it from the first one (an X on the right) and go back from the next ones.
  const affordance = useBackAffordance();
  return (
    <header className="flex min-h-11 items-center gap-1">
      {onBack !== undefined && affordance === 'back' && (
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
      {onBack !== undefined && affordance === 'close' && (
        <Button variant="ghost" size="icon" onClick={onBack} aria-label={t('side.close', { ns: 'wide' })}>
          <X className="size-5" aria-hidden="true" />
        </Button>
      )}
    </header>
  );
}
