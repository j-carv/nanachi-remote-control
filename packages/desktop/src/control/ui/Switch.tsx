import { cx } from './cx.js';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean | undefined;
  /** Accessible name when there is no visible label to point at with `labelledBy`. */
  label?: string | undefined;
  labelledBy?: string | undefined;
  describedBy?: string | undefined;
  id?: string | undefined;
}

/**
 * A toggle in neutral greys: on is the foreground colour, off is the control grey. 36 x 20 px. The thumb travels on the
 * premium ease and widens a little while the control is pressed, so the press reads before the release.
 */
export function Switch({ checked, onCheckedChange, disabled = false, label, labelledBy, describedBy, id }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      data-state={checked ? 'checked' : 'unchecked'}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        'group inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-[var(--ease-premium)] disabled:pointer-events-none disabled:opacity-45',
        checked ? 'bg-primary' : 'bg-input',
      )}
    >
      <span
        aria-hidden="true"
        className={cx(
          'pointer-events-none block size-4 rounded-full shadow-sm transition-[translate,scale,background-color] duration-200 ease-[var(--ease-premium)] group-active:scale-x-[1.18]',
          checked ? 'translate-x-4 bg-primary-foreground' : 'translate-x-0 bg-card',
        )}
      />
    </button>
  );
}
