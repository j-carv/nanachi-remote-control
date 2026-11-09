import { LoaderCircle } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from './cx.js';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'danger-ghost';
export type ButtonSize = 'sm' | 'md' | 'icon' | 'icon-sm';

// The press is Tailwind's `scale` property, so the transition lists `scale` (not `transform`) for it to glide.
const BASE =
  'inline-flex shrink-0 items-center justify-center rounded-md font-medium whitespace-nowrap select-none transition-[background-color,color,opacity,scale] duration-180 ease-[var(--ease-premium)] active:scale-[0.98] active:duration-110 motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/88',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
  outline: 'border border-border bg-card text-foreground hover:bg-accent',
  ghost: 'text-foreground hover:bg-accent',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  'danger-ghost': 'text-destructive hover:bg-destructive/10',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[13px]',
  md: 'h-8 gap-2 px-3.5 text-[13px]',
  icon: 'size-8',
  'icon-sm': 'size-7',
};

export interface ButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner in place of the icon and disables the button. */
  loading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

export function Button({ variant = 'secondary', size = 'md', loading = false, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cx(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {loading ? (
        <span className="inline-grid animate-scale-in">
          <LoaderCircle className="animate-spin" aria-hidden="true" />
        </span>
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
