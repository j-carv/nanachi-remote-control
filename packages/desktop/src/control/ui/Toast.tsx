import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx } from './cx.js';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  message: string;
  title?: string;
  tone?: ToastTone;
}

interface ToastItem extends ToastInput {
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
const MAX_VISIBLE = 4;

const ICONS = {
  success: <CircleCheck className="text-success" aria-hidden="true" />,
  error: <CircleAlert className="text-destructive" aria-hidden="true" />,
  info: <Info className="text-muted-foreground" aria-hidden="true" />,
} satisfies Record<ToastTone, ReactNode>;

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setTimeout(() => onDismiss(item.id), LIFETIME_MS[item.tone]);
    return () => window.clearTimeout(timer);
  }, [paused, item.id, item.tone, onDismiss]);

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="pointer-events-auto animate-toast flex items-start gap-2.5 rounded-lg border border-border bg-popover py-2.5 pr-2 pl-3.5 text-popover-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.35)]"
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{ICONS[item.tone]}</span>
      <div className="min-w-0 flex-1 pt-px">
        {item.title ? <div className="text-[13px] leading-5 font-medium">{item.title}</div> : null}
        <div className={cx('text-[13px] leading-5', item.title ? 'text-muted-foreground' : 'text-foreground')}>{item.message}</div>
      </div>
      <button
        type="button"
        aria-label="Dispensar aviso"
        onClick={() => onDismiss(item.id)}
        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
      >
        <X aria-hidden="true" />
      </button>
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

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div role="region" aria-label="Notificações" className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[344px] flex-col gap-2">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
