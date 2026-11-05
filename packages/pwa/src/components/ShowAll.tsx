import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface ShowAllProps {
  /** Quantos itens ficaram de fora do corte. Zero: não mostra nada. */
  hidden: number;
  onExpand(): void;
}

/** Botão "Mostrar tudo (N linhas)" depois de um corte de saída longa. O que se conta são linhas. */
export function ShowAll({ hidden, onExpand }: ShowAllProps) {
  const { t } = useTranslation();
  if (hidden === 0) return null;
  return (
    <Button variant="ghost" className="text-muted-foreground" onClick={onExpand}>
      {t('showAll', { count: hidden })}
    </Button>
  );
}
