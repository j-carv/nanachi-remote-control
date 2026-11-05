import * as React from 'react';
import { Drawer as DrawerPrimitive } from 'vaul';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/chat/useMediaQuery';
import { WIDE_QUERY } from '@/wide/layout';

// Bottom sheet (vaul) instead of a centred dialog: on the phone every overlay rises from the bottom. On a wide screen
// (the `wide:` classes below) the same sheet is a centred dialog or a side panel; there it is not dragged down, so only
// the (hidden) handle drags.
function Drawer({ ...props }: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  const wide = useMediaQuery(WIDE_QUERY);
  return <DrawerPrimitive.Root data-slot="drawer" handleOnly={wide} {...props} />;
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

/**
 * Where the sheet goes from 900 px. The classes use `!` because vaul's own stylesheet (not in a cascade layer) positions
 * the sheet with a slide-up animation, and a layered rule only wins over it when it is important. `dialog`: centred, 32 rem.
 * `side`: a panel on the right edge, full height, for what the user reads while the chat stays visible.
 */
const WIDE_PLACEMENT = {
  dialog:
    'wide:top-1/2 wide:right-auto wide:bottom-auto wide:left-1/2 wide:w-[min(28rem,calc(100vw-4rem))] wide:max-h-[min(46rem,calc(100dvh-4rem))] wide:-translate-x-1/2 wide:-translate-y-1/2 wide:rounded-xl wide:border wide:data-[state=open]:animate-dialog-in! wide:data-[state=closed]:animate-dialog-out!',
  side: 'wide:top-0 wide:right-0 wide:bottom-0 wide:left-auto wide:h-dvh wide:w-[min(26rem,100vw)] wide:max-h-none wide:rounded-none wide:border-t-0 wide:border-l wide:data-[state=open]:animate-panel-in! wide:data-[state=closed]:animate-dialog-out!',
} as const;

function DrawerContent({
  className,
  children,
  panel = 'dialog',
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Content> & { panel?: keyof typeof WIDE_PLACEMENT }) {
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        data-slot="drawer-content"
        data-panel={panel}
        className={cn(
          'group/drawer-content fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-2xl border-t border-border bg-popover text-popover-foreground outline-none',
          WIDE_PLACEMENT[panel],
          'wide:shadow-lg wide:select-text! wide:after:hidden wide:motion-reduce:animate-none!',
          className,
        )}
        {...props}
      >
        <div className="mx-auto mt-2.5 hidden h-1.5 w-11 shrink-0 rounded-full bg-muted-foreground/40 group-data-[vaul-drawer-direction=bottom]/drawer-content:block wide:hidden!" />
        {children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="drawer-header" className={cn('flex flex-col gap-1 px-5 pt-4', className)} {...props} />;
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
      className={cn('text-xl font-semibold tracking-tight text-foreground', className)}
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
