import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/chat/useMediaQuery';
import { Button } from '@/components/ui/button';
import { WIDE_QUERY } from '@/wide/layout';

// Bottom sheet (vaul) instead of a centred dialog: on the phone every overlay rises from the bottom. On a wide screen
// (the `wide:` classes below) the same sheet is a centred dialog or a side panel; there it is not dragged down, so only
// the (hidden) handle drags.

/** Whether the sheet above the content can be dismissed. A close button that could not close the sheet is not drawn. */
const DismissibleContext = React.createContext(true);

function Drawer({ dismissible = true, ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  const wide = useMediaQuery(WIDE_QUERY);
  return (
    <DismissibleContext.Provider value={dismissible}>
      <DrawerPrimitive.Root data-slot="drawer" handleOnly={wide} dismissible={dismissible} {...props} />
    </DismissibleContext.Provider>
  );
}

function DrawerPortal({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerOverlay({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Overlay>) {
  return (
    <DrawerPrimitive.Overlay
      data-slot="drawer-overlay"
      className={cn('fixed inset-0 z-50 bg-black/40', className)}
      {...props}
    />
  );
}

export type DrawerPanel = 'dialog' | 'side';
/** Width of a dialog: `sm` for a confirmation or a single field, `md` (the default) for a form, `lg` for a list to read. */
export type DrawerSize = 'sm' | 'md' | 'lg';

/**
 * Where the sheet goes from 900 px. The classes use `!` because vaul's own stylesheet (not in a cascade layer) positions
 * the sheet with a slide-up animation, and a layered rule only wins over it when it is important. `dialog`: centred,
 * its width from `DIALOG_WIDTH`. `side`: a panel on the right edge, full height, for what the user reads while the chat
 * stays visible.
 * The entrances and exits are `motion-safe:`: their selectors are more specific than `motion-reduce:animate-none!`, so
 * the reduced-motion case has to leave them out rather than override them.
 */
const WIDE_PLACEMENT: Record<DrawerPanel, string> = {
  dialog:
    'wide:top-1/2 wide:right-auto wide:bottom-auto wide:left-1/2 wide:max-h-[min(46rem,calc(100dvh-4rem))] wide:-translate-x-1/2 wide:-translate-y-1/2 wide:rounded-xl wide:border wide:data-[state=open]:motion-safe:animate-dialog-in! wide:data-[state=closed]:motion-safe:animate-dialog-out!',
  side: 'wide:top-0 wide:right-0 wide:bottom-0 wide:left-auto wide:h-dvh wide:w-[min(26rem,100vw)] wide:max-h-none wide:rounded-none wide:border-t-0 wide:border-l wide:data-[state=open]:motion-safe:animate-panel-in! wide:data-[state=closed]:motion-safe:animate-dialog-out!',
};

const DIALOG_WIDTH: Record<DrawerSize, string> = {
  sm: 'wide:w-[min(24rem,calc(100vw-4rem))]',
  md: 'wide:w-[min(28rem,calc(100vw-4rem))]',
  lg: 'wide:w-[min(36rem,calc(100vw-4rem))]',
};

interface DrawerContentProps extends React.ComponentProps<typeof DrawerPrimitive.Content> {
  panel?: DrawerPanel;
  size?: DrawerSize;
  /** Wide dialogs get a close button in their corner unless this is set (a sheet whose own button already closes it). */
  hideClose?: boolean;
}

/**
 * Whether the sheet draws its close button in the corner: a wide centred dialog that can be dismissed right now and is
 * not told to hide it. The phone closes its sheets by dragging or by Cancel, and a side panel keeps its own header.
 */
export function showsCloseButton(state: {
  wide: boolean;
  panel: DrawerPanel;
  dismissible: boolean;
  hideClose: boolean;
}): boolean {
  return state.wide && state.panel === 'dialog' && state.dismissible && !state.hideClose;
}

function DrawerContent({ className, children, panel = 'dialog', size = 'md', hideClose = false, ...props }: DrawerContentProps) {
  const { t } = useTranslation('common');
  const wide = useMediaQuery(WIDE_QUERY);
  const dismissible = React.useContext(DismissibleContext);
  const showClose = showsCloseButton({ wide, panel, dismissible, hideClose });
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        data-panel={panel}
        className={cn(
          'group/drawer-content fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-2xl border-t border-border bg-popover text-popover-foreground outline-none',
          WIDE_PLACEMENT[panel],
          panel === 'dialog' && DIALOG_WIDTH[size],
          'wide:shadow-lg wide:select-text! wide:after:hidden wide:motion-reduce:animate-none!',
          className,
        )}
        {...props}
      >
        <div className="mx-auto mt-2.5 hidden h-1.5 w-11 shrink-0 rounded-full bg-muted-foreground/40 group-data-[vaul-drawer-direction=bottom]/drawer-content:block wide:hidden!" />
        {children}
        {showClose && (
          <DrawerPrimitive.Close asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-slot="drawer-close"
              aria-label={t('actions.close')}
              className="absolute top-3 right-3 wide:size-9"
            >
              <X aria-hidden="true" />
            </Button>
          </DrawerPrimitive.Close>
        )}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

/** The top of a sheet: the title and the description. On a wide dialog it leaves room for the close button. */
function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        'flex flex-col gap-1 px-5 pt-4 wide:group-data-[panel=dialog]/drawer-content:pt-5 wide:group-data-[panel=dialog]/drawer-content:pr-14',
        className,
      )}
      {...props}
    />
  );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn('mt-auto flex flex-col gap-2 px-5 pt-4 pb-[max(env(safe-area-inset-bottom),16px)]', className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(
        'text-xl font-semibold tracking-tight text-foreground wide:group-data-[panel=dialog]/drawer-content:text-lg',
        className,
      )}
      {...props}
    />
  );
}

function DrawerDescription({ className, ...props }: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
