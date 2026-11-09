import { useRef, useState } from 'react';
import { Check, Ellipsis, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/components/ui/drawer';
import { cn } from '@/lib/utils';
import { useModalOverlay } from './useModalOverlay.js';

export interface ActionSheetItem {
  label: string;
  /** Icon before the label (a row of the menu). Decorative: the label names the action. */
  icon?: LucideIcon | undefined;
  /** Second line under the label (the description of an option). */
  detail?: string | undefined;
  /** The row opens a dialog (a sheet or a drawer): `aria-haspopup`, as the header's own buttons had. */
  haspopup?: 'dialog' | undefined;
  /** `danger`: red text (destructive). `muted`: secondary row (e.g. send the text as is). */
  tone?: 'danger' | 'muted' | undefined;
  /** Monospace label (command names and their choices). */
  mono?: boolean | undefined;
  /** Option row: when defined, `aria-current` marks the current value and a check mark shows it. */
  checked?: boolean | undefined;
  /** Header shown above the first of a run of consecutive items with the same section (e.g. a model's provider). */
  section?: string | undefined;
  /** The row keeps the user on the same screen (a toggle): the sheet hands the focus back to its trigger after the pick. */
  keepsFocus?: boolean | undefined;
  /** Run synchronously on the click when a browser API needs a user gesture. */
  requiresActivation?: boolean | undefined;
  onSelect(): void;
}

/**
 * Whether picking this row leaves the focus to its own action (the chat field, a new screen) rather than returning it to
 * the button that opened the sheet. Every row does, except one that keeps the focus (`keepsFocus`).
 */
export function pickMovesFocus(item: ActionSheetItem): boolean {
  return item.keepsFocus !== true;
}

interface ActionSection {
  title: string | undefined;
  entries: Array<{ item: ActionSheetItem; index: number }>;
}

/** Splits the items into runs of the same `section`, keeping their order. Items without a section form one run. */
function sectionsOf(items: readonly ActionSheetItem[]): ActionSection[] {
  const sections: ActionSection[] = [];
  items.forEach((item, index) => {
    const last = sections.at(-1);
    if (last !== undefined && last.title === item.section) last.entries.push({ item, index });
    else sections.push({ title: item.section, entries: [{ item, index }] });
  });
  return sections;
}

interface ActionSheetPanelProps {
  /** Título visível no topo da folha (nome da sessão, ou `/comando`). */
  title: string;
  items: readonly ActionSheetItem[];
  onClose(): void;
  /** Chamado quando uma ação é escolhida (não no Cancelar). Quem recebe decide quando a ação roda. */
  onPick(action: () => void, item: ActionSheetItem): void;
}

/**
 * Conteúdo da folha: o grupo de ações (rolável dentro da folha) e "Cancelar" em grupo à parte. Escolher uma ação
 * entrega a ação a `onPick`, que fecha a folha e a roda depois. Fica fora do Drawer para os testes renderizarem o
 * markup estático.
 */
export function ActionSheetPanel({ title, items, onClose, onPick }: ActionSheetPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 px-3 pt-1 pb-[max(env(safe-area-inset-bottom),12px)] wide:px-4 wide:pt-4 wide:pb-4">
      <div className="overflow-hidden rounded-xl bg-card">
        <p data-slot="action-sheet-title" className="border-b border-border px-4 py-3 text-center text-sm text-muted-foreground">{title}</p>
        <div className="max-h-[60dvh] overflow-y-auto">
          {sectionsOf(items).map((section, sectionIndex) => (
            <div key={sectionIndex} className={cn(sectionIndex > 0 && 'border-t border-border')}>
              {section.title !== undefined && (
                <p
                  data-slot="action-sheet-section-title"
                  className="sticky top-0 z-10 bg-card px-4 pt-3 pb-1 text-sm text-muted-foreground"
                >
                  {section.title}
                </p>
              )}
              <div className="divide-y divide-border">
                {section.entries.map(({ item, index }) => (
                  <button
                    key={`${index}-${item.label}`}
                    type="button"
                    data-slot="action-sheet-item"
                    data-tone={item.tone}
                    data-mono={item.mono === true ? 'true' : undefined}
                    aria-current={item.checked === true ? 'true' : undefined}
                    aria-haspopup={item.haspopup}
                    className={cn(
                      'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left text-base text-foreground transition-[background-color,scale] duration-200 ease-out-premium hover:bg-accent active:bg-accent active:scale-[0.99] wide:min-h-10 wide:py-2',
                      item.tone === 'danger' && 'text-destructive',
                      item.tone === 'muted' && 'text-muted-foreground',
                      item.mono === true && 'font-mono text-[15px]',
                    )}
                    onClick={() => onPick(item.onSelect, item)}
                  >
                    {item.icon !== undefined && <item.icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span data-slot="action-sheet-label" className="truncate">{item.label}</span>
                      {item.detail !== undefined && <span className="text-sm text-muted-foreground">{item.detail}</span>}
                    </span>
                    {item.checked === true && <Check className="size-5 shrink-0" aria-hidden="true" data-check="true" />}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl bg-card">
        <button
          type="button"
          data-slot="action-sheet-cancel"
          className="flex min-h-14 w-full items-center justify-center px-4 text-base font-semibold text-foreground transition-[background-color,scale] duration-200 ease-out-premium hover:bg-accent active:bg-accent active:scale-[0.99] wide:min-h-10"
          onClick={onClose}
        >
          {t('actions.cancel')}
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
  // A picked row hands the focus to its own action (e.g. the chat field). Otherwise Radix returns the focus to the
  // button that opened the sheet once it closes. A row with `keepsFocus` and Cancel both return it, as before.
  const actionOwnsFocusRef = useRef(false);

  return (
    <Drawer
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DrawerContent
        size="sm"
        hideClose
        onCloseAutoFocus={(event) => {
          if (actionOwnsFocusRef.current) event.preventDefault();
        }}
      >
        <DrawerTitle className="sr-only">{label}</DrawerTitle>
        <DrawerDescription className="sr-only">{title}</DrawerDescription>
        <ActionSheetPanel
          title={title}
          items={items}
          onClose={onClose}
          onPick={(action, item) => {
            // The action runs after this sheet's history entry is popped (see useModalOverlay).
            actionOwnsFocusRef.current = pickMovesFocus(item);
            if (item.requiresActivation) {
              action();
              onClose();
              return;
            }
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
