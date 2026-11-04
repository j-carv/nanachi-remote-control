interface ShowAllProps {
  /** Quantos itens ficaram de fora do corte. Zero: não mostra nada. */
  hidden: number;
  unit: string;
  onExpand(): void;
}

/** Botão "Mostrar tudo (N linhas)" depois de um corte de saída longa. */
export function ShowAll({ hidden, unit, onExpand }: ShowAllProps) {
  if (hidden === 0) return null;
  return (
    <button type="button" className="show-all" onClick={onExpand}>
      Mostrar tudo ({hidden} {unit})
    </button>
  );
}
