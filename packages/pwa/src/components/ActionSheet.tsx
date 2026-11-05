import { useRef, useState } from 'react';
import { Check, Ellipsis } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { useModalOverlay } from './useModalOverlay.js';

export interface ActionSheetItem {
  label: string;
  /** Second line under the label (the description of an option). */
  detail?: string | undefined;
  /** `danger`: red text (destructive). `muted`: secondary row (e.g. send the text as is). */
  tone?: 'danger' | 'muted' | undefined;
  /** Monospace label (command names and their choices). */
  mono?: boolean | undefined;
  /** Option row: when defined, `aria-current` marks the current value and a check mark shows it. */
  checked?: boolean | undefined;
  onSelect(): void;
}

interface ActionSheetPanelProps {
  /** Título visível no topo da folha (nome da sessão, ou `/comando`). */
  title: string;
  items: readonly ActionSheetItem[];
  onClose(): void;
  /** Chamado quando uma ação é escolhida (não no Cancelar). Quem recebe decide quando a ação roda. */
  onPick(action: () => void): void;
}

/**
 * Conteúdo da folha: o grupo de ações (rolável dentro da folha) e "Cancelar" em grupo à parte. Escolher uma ação
 * entrega a ação a `onPick`, que fecha a folha e a roda depois. Fica fora do Drawer para os testes renderizarem o
 * markup estático.
 */
export function ActionSheetPanel({ title, items, onClose, onPick }: ActionSheetPanelProps) {
  return (
    <div className="flex flex-col gap-2 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),12px)]">
      <div className="overflow-hidden rounded-xl bg-card">
        <p data-slot="action-sheet-title" className="border-b border-border px-4 py-3 text-center text-sm text-muted-foreground">{title}</p>
        <div className="max-h-[60dvh] divide-y divide-border overflow-y-auto">
          {items.map((item, index) => (
            <button
              key={`${index}-${item.label}`}
              type="button"
              data-slot="action-sheet-item"
              data-tone={item.tone}
              data-mono={item.mono === true ? 'true' : undefined}
              aria-current={item.checked === true ? 'true' : undefined}
              className={cn(
                'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left text-base text-foreground transition-colors hover:bg-accent active:bg-accent',
                item.tone === 'danger' && 'text-destructive',
                item.tone === 'muted' && 'text-muted-foreground',
                item.mono === true && 'font-mono text-[15px]',
              )}
              onClick={() => onPick(item.onSelect)}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span data-slot="action-sheet-label" className="truncate">{item.label}</span>
                {item.detail !== undefined && <span className="text-sm text-muted-foreground">{item.detail}</span>}
              </span>
              {item.checked === true && <Check className="size-5 shrink-0" aria-hidden="true" data-check="true" />}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl bg-card">
        <button
          type="button"
          data-slot="action-sheet-cancel"
          className="flex min-h-14 w-full items-center justify-center px-4 text-base font-semibold text-foreground transition-colors hover:bg-accent active:bg-accent"
          onClick={onClose}
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

interface ActionSheetProps {
  label: string;
  title: string;
  items: readonly ActionSheetItem[];
  onClose(): void;
}

/**
 * Folha de ações estilo iOS (Drawer, sobe de baixo). Toque no fundo, arrastar para baixo, Esc e o voltar do
 * navegador fecham. A lista por trás fica travada enquanto a folha está aberta.
 */
export function ActionSheet({ label, title, items, onClose }: ActionSheetProps) {
  const closeThen = useModalOverlay(onClose);
  // Ao escolher uma ação, quem manda no foco é a própria ação (ex.: o campo do chat). Sem isso, o Radix devolve o
  // foco ao botão que abriu a folha depois que ela fecha. No Cancelar, o foco volta ao botão, como antes.
  const pickedRef = useRef(false);

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent
        onCloseAutoFocus={(event) => {
          if (pickedRef.current) event.preventDefault();
        }}
      >
        <DrawerTitle className="sr-only">{label}</DrawerTitle>
        <DrawerDescription className="sr-only">{title}</DrawerDescription>
        <ActionSheetPanel
          title={title}
          items={items}
          onClose={onClose}
          onPick={(action) => {
            // The action runs after this sheet's history entry is popped (see useModalOverlay).
            pickedRef.current = true;
            closeThen(action);
          }}
        />
      </DrawerContent>
    </Drawer>
  );
}

interface ActionSheetButtonProps {
  label: string;
  title: string;
  items: readonly ActionSheetItem[];
}

/** Botão "…" (44px) que abre a folha de ações. */
export function ActionSheetButton({ label, title, items }: ActionSheetButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Ellipsis aria-hidden="true" />
      </Button>
      {open && <ActionSheet label={label} title={title} items={items} onClose={() => setOpen(false)} />}
    </>
  );
}
