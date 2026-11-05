import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useToastsHeld } from '../state/toast-hold.js';
import { cx } from './cx.js';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  message: string;
  title?: string;
  tone?: ToastTone;
}

export interface ToastItem extends ToastInput {
  id: number;
  tone: ToastTone;
}

type Notify = (toast: ToastInput) => void;

const ToastContext = createContext<Notify>(() => undefined);

/** `const toast = useToast(); toast({ message: 'Salvo.', tone: 'success' })`. */
export function useToast(): Notify {
  return useContext(ToastContext);
}

const LIFETIME_MS: Record<ToastTone, number> = { success: 4500, info: 4500, error: 8000 };
/** How long a toast slides out before it is removed: the `animate-toast-out` length (styles.css). */
const EXIT_MS = 180;
const MAX_VISIBLE = 4;

const ICONS = {
  success: <CircleCheck className="text-success" aria-hidden="true" />,
  error: <CircleAlert className="text-destructive" aria-hidden="true" />,
  info: <Info className="text-muted-foreground" aria-hidden="true" />,
} satisfies Record<ToastTone, ReactNode>;

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(false);
  // Leaving plays the exit first; the owner removes the toast when it has finished.
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (paused || leaving) return undefined;
    const timer = window.setTimeout(() => setLeaving(true), LIFETIME_MS[item.tone]);
    return () => window.clearTimeout(timer);
  }, [paused, leaving, item.tone]);

  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => onDismiss(item.id), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, item.id, onDismiss]);

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={cx(
        'pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-popover py-2.5 pr-2 pl-3.5 text-popover-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)]',
        leaving ? 'animate-toast-out' : 'animate-toast',
      )}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{ICONS[item.tone]}</span>
      <div className="min-w-0 flex-1 pt-px">
        {item.title ? <div className="text-[13px] leading-5 font-medium">{item.title}</div> : null}
        <div className={cx('text-[13px] leading-5', item.title ? 'text-muted-foreground' : 'text-foreground')}>{item.message}</div>
      </div>
      <button
        type="button"
        aria-label={t('shell.toast.dismiss')}
        onClick={() => setLeaving(true)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}

export interface ToastStackProps {
  items: readonly ToastItem[];
  /** The sessions view is on screen: the toasts wait (they stay queued) and show when it is gone. */
  held: boolean;
  onDismiss: (id: number) => void;
}

/** The region the toasts appear in. It stays for screen readers even while empty or while the toasts wait. */
export function ToastStack({ items, held, onDismiss }: ToastStackProps) {
  const { t } = useTranslation();
  return (
    <div role="region" aria-label={t('shell.toast.region')} className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[344px] flex-col gap-2">
      {held ? null : items.map((item) => <ToastCard key={item.id} item={item} onDismiss={onDismiss} />)}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const notify = useCallback<Notify>((toast) => {
    counter.current += 1;
    const item: ToastItem = { ...toast, id: counter.current, tone: toast.tone ?? 'info' };
    setItems((current) => [...current, item].slice(-MAX_VISIBLE));
  }, []);
  const value = useMemo(() => notify, [notify]);
  // The sessions view is drawn over the content area by main, where the toasts sit: they wait while it is on screen.
  const held = useToastsHeld();

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack items={items} held={held} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
