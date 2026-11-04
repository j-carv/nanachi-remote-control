import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import { DotsThree } from '@phosphor-icons/react';

export interface OverflowItem {
  label: string;
  /** `danger`: texto vermelho (ação destrutiva). */
  tone?: 'danger' | undefined;
  onSelect(): void;
}

interface OverflowMenuProps {
  /** Nome do botão para leitor de tela (ex.: "Mais ações da sessão"). */
  label: string;
  items: readonly OverflowItem[];
}

/**
 * Botão "…" (44px) com um menu flutuante. O menu sai com `position: fixed` na posição do botão, para não ser cortado
 * pela lista (`.item-list` tem overflow oculto). Fora do menu, um toque fecha; Esc também.
 */
export function OverflowMenu({ label, items }: OverflowMenuProps) {
  const [anchor, setAnchor] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (anchor === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAnchor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anchor]);

  function toggle(event: MouseEvent<HTMLButtonElement>) {
    if (anchor !== null) {
      setAnchor(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }

  return (
    <>
      <button
        type="button"
        className="icon-button overflow-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={toggle}
      >
        <DotsThree size={26} weight="bold" aria-hidden="true" />
      </button>
      {anchor !== null && (
        <>
          <button type="button" className="menu-scrim" aria-label="Fechar menu" tabIndex={-1} onClick={() => setAnchor(null)} />
          <ul className="menu" role="menu" aria-label={label} style={anchor}>
            {items.map((item) => (
              <li key={item.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={item.tone === 'danger' ? 'menu-item danger' : 'menu-item'}
                  onClick={() => {
                    setAnchor(null);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
