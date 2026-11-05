import { useEffect, useId, useRef, type ReactNode } from 'react';
import { acquireOverlay } from '../state/overlay.js';
import { cx } from './cx.js';
import { afterNativeClose } from './dialog-logic.js';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned. The first focusable element gets the focus, so put the safe choice first. */
  footer?: ReactNode;
  /** False while an operation runs: Escape and the backdrop do nothing. */
  dismissible?: boolean;
  /** Width in px (default 440), capped to the window. */
  width?: number;
  className?: string;
}

/**
 * A centred modal dialog on the native `<dialog>`: focus trap, Escape, inert background and focus restore come from the
 * platform. The `open` prop is the single source of truth (Escape asks `onClose`, it never closes by itself, and when
 * the browser closes the element anyway the `close` event brings the prop back in line). While it is open the title bar
 * stops being a drag region, so a click on the backdrop reaches it.
 */
export function Dialog({ open, onClose, title, description, children, footer, dismissible = true, width = 440, className }: DialogProps) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return undefined;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) return undefined;
    document.documentElement.setAttribute('data-modal', '');
    // The sessions view is drawn over the content area by main: it steps aside while this dialog is open.
    const release = acquireOverlay();
    return () => {
      release();
      document.documentElement.removeAttribute('data-modal');
    };
  }, [open]);

  return (
    <dialog
      ref={element}
      className={cx(
        'ui-dialog m-auto rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-[0_24px_64px_-16px_rgb(0_0_0/0.4)] backdrop:bg-black/40',
        className,
      )}
      style={{ width: `min(${width}px, calc(100vw - 48px))` }}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      // The element can close by itself (a second Escape in a row cannot be cancelled): bring `open` back in line.
      onClose={(event) => {
        const action = afterNativeClose({ open, dismissible });
        if (action === 'ask-close') onClose();
        else if (action === 'reopen' && !event.currentTarget.open) event.currentTarget.showModal();
      }}
      onClick={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className="flex flex-col gap-1 px-5 pt-5 pb-4">
          <h2 id={titleId} className="font-display text-[15px] leading-6 font-semibold">
            {title}
          </h2>
          {description ? (
            <div id={descriptionId} className="text-[13px] leading-5 text-muted-foreground">
              {description}
            </div>
          ) : null}
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      ) : null}
      {open && footer ? <div className="flex flex-wrap items-center justify-end gap-2 px-5 pt-1 pb-5">{footer}</div> : null}
    </dialog>
  );
}
