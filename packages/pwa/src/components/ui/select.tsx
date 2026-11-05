import * as React from 'react';
import { Select as SelectPrimitive } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

// A styled dropdown for a wide screen (radix Select, the same popover pattern as dropdown-menu.tsx). The phone keeps the
// native select, whose wheel is the platform's own control. The trigger is drawn by the caller: it shows the chosen
// value however the row needs (a model and its provider, an account and its e-mail), which a SelectValue cannot do.

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

/** The button that opens the list. Its children are the visible value; the caller draws the chevron. */
function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-left text-base text-foreground outline-none transition-[border-color,box-shadow] duration-200 ease-out-premium focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:border-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {children}
    </SelectPrimitive.Trigger>
  );
}

/** The open list, in a popover under the trigger (it flips above when there is no room below). */
function SelectContent({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position="popper"
        sideOffset={4}
        className={cn(
          'z-50 max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-lg data-[state=closed]:animate-fade-out data-[state=open]:animate-enter-scale',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

/** A heading over a group of options (a model's provider). */
function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('px-2.5 pt-2 pb-1 text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

/** One option. `textValue` is what typing to find it matches; the check mark shows the chosen one. */
function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex min-h-9 w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2.5 text-base outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectTrigger, SelectContent, SelectGroup, SelectLabel, SelectItem };
