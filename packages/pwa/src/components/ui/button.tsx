import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Alvo de toque de 44px (h-11 / size-11) em todas as variantes, como pede docs/DESIGN.md.
const buttonVariants = cva(
  // Colour and position ease together. The press scales to 0.98. `hover:` only applies where a pointer can hover,
  // so a touch screen never lifts a button. The lift is a 1 px move (no shadow, per the design rules); ghost buttons do not lift.
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-base font-medium whitespace-nowrap transition-[translate,scale,background-color,color,border-color,box-shadow,opacity] duration-180 ease-out-premium outline-none select-none active:scale-[0.98] active:duration-110 motion-reduce:transition-none motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground hover:bg-primary/90 hover:-translate-y-px motion-reduce:hover:translate-y-0',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-accent hover:-translate-y-px motion-reduce:hover:translate-y-0',
        outline:
          'border-border bg-card text-foreground hover:bg-accent hover:-translate-y-px motion-reduce:hover:translate-y-0',
        ghost: 'text-foreground hover:bg-accent',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 hover:-translate-y-px motion-reduce:hover:translate-y-0',
        'destructive-ghost': 'text-destructive hover:bg-destructive/10',
      },
      size: {
        default: 'h-11 px-4',
        // A dialog's button: 44 px on the phone, 36 px in a wide dialog (`wide:`). The right pane keeps `default`.
        compact: 'h-11 px-4 wide:h-9 wide:px-3.5',
        icon: 'size-11 p-0',
        wide: 'h-11 w-full px-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
export type { ButtonProps };
