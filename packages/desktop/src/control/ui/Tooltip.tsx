import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx.js';

export interface TooltipProps {
  label: string;
  /** Shown after the label, quieter (`Ctrl+B`). Absent for a section without a shortcut. */
  shortcut?: string | undefined;
  side?: 'top' | 'bottom' | 'right';
  /** `end` right-aligns the tooltip to its anchor (for controls at the window edge). */
  align?: 'center' | 'end';
  children: ReactNode;
}

const HOVER_DELAY_MS = 450;
/** How long a tooltip stays on screen after the pointer leaves: the `animate-scale-out` length (styles.css). */
const EXIT_MS = 120;
const EDGE = 12;
/** The tooltip grows out of its anchor's edge: the scale starts from the side that faces the control. */
const ORIGIN: Record<NonNullable<TooltipProps['side']>, string> = { top: 'center bottom', bottom: 'center top', right: 'left center' };

function placement(rect: DOMRect, side: NonNullable<TooltipProps['side']>, align: NonNullable<TooltipProps['align']>): CSSProperties {
  const centerX = Math.min(Math.max(rect.left + rect.width / 2, 70), window.innerWidth - 70);
  if (side === 'right') return { left: rect.right + 8, top: rect.top + rect.height / 2, transform: 'translateY(-50%)' };
  const vertical = side === 'top' ? { top: rect.top - 6, transform: 'translateY(-100%)' } : { top: rect.bottom + 6 };
  if (align === 'end') {
    return { ...vertical, right: Math.max(EDGE, window.innerWidth - rect.right) };
  }
  return { ...vertical, left: centerX, transform: `translateX(-50%) ${vertical.transform ?? ''}`.trim() };
}

/**
 * A tooltip for icon-only controls and clipped text. Portal-based, so a group's `overflow-hidden` never clips it.
 * It is decorative: the control carries its own `aria-label`, so nothing is announced twice. The delay applies to the
 * pointer; a keyboard focus shows it at once. It scales in on show and scales out on hide: the element stays mounted for
 * `EXIT_MS` after the hide, so the exit can play.
 */
export function Tooltip({ label, shortcut, side = 'top', align = 'center', children }: TooltipProps) {
  const wrapper = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [leaving, setLeaving] = useState(false);

  const hide = (): void => {
    window.clearTimeout(timer.current);
    // Nothing on screen: the pending show (if any) is cancelled above, and there is no exit to play.
    if (anchor === null) return;
    setLeaving(true);
    timer.current = window.setTimeout(() => {
      setAnchor(null);
      setLeaving(false);
    }, EXIT_MS);
  };
  const show = (delay: number): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const target = wrapper.current?.firstElementChild;
      if (target) setAnchor(target.getBoundingClientRect());
      setLeaving(false);
    }, delay);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!anchor) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, [anchor]);

  return (
    <>
      <span
        ref={wrapper}
        className="contents"
        onMouseEnter={() => show(HOVER_DELAY_MS)}
        onMouseLeave={hide}
        onPointerDown={hide}
        onFocus={(event) => {
          if (event.target instanceof HTMLElement && event.target.matches(':focus-visible')) show(0);
        }}
        onBlur={hide}
      >
        {children}
      </span>
      {anchor
        ? createPortal(
            <div
              aria-hidden="true"
              style={{ ...placement(anchor, side, align), transformOrigin: ORIGIN[side] }}
              className={cx(
                'pointer-events-none fixed z-[100] flex max-w-[260px] items-center gap-2 rounded-md bg-foreground px-2 py-1 text-xs leading-4 text-background shadow-md',
                leaving ? 'animate-scale-out' : 'animate-scale-in',
              )}
            >
              <span>{label}</span>
              {shortcut ? <span className="text-[11px] opacity-65">{shortcut}</span> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
