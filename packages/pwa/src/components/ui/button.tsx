import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Alvo de toque de 44px (h-11 / size-11) em todas as variantes, como pede docs/DESIGN.md.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent text-base font-medium whitespace-nowrap transition-[transform,background-color,opacity] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] outline-none select-none active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        outline: 'border-border bg-card text-foreground hover:bg-accent',
        ghost: 'text-foreground hover:bg-accent',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        'destructive-ghost': 'text-destructive hover:bg-destructive/10',
      },
      size: {
        default: 'h-11 px-4',
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
