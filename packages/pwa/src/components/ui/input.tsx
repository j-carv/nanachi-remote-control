import * as React from 'react';
import { cn } from '@/lib/utils';

// 16px no campo: abaixo disso o iOS dá zoom ao focar. Altura de 44px para o toque.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-base text-foreground shadow-none outline-none transition-[border-color,box-shadow] duration-200 ease-out-premium placeholder:text-muted-foreground file:border-0 file:bg-transparent disabled:pointer-events-none disabled:opacity-50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
