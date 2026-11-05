import { cn } from '@/lib/utils';

/** Tons de status: os únicos com cor no app. O resto é cinza. */
export type StatusTone = 'running' | 'attention' | 'success' | 'danger' | 'muted';

export const TONE_TEXT: Record<StatusTone, string> = {
  running: 'text-running',
  attention: 'text-attention',
  success: 'text-success',
  danger: 'text-destructive',
  muted: 'text-muted-foreground',
};

const TONE_BG: Record<StatusTone, string> = {
  running: 'bg-running',
  attention: 'bg-attention',
  success: 'bg-success',
  danger: 'bg-destructive',
  muted: 'bg-muted-foreground/50',
};

interface StatusDotProps {
  tone: StatusTone;
  /** Pisca devagar enquanto conecta (estado, não enfeite). */
  pulse?: boolean | undefined;
}

/** Bolinha de estado (conexão de uma máquina, conta de agente). Decorativa: o texto ao lado diz o estado. */
export function StatusDot({ tone, pulse = false }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full',
        TONE_BG[tone],
        pulse && 'animate-pulse motion-reduce:animate-none',
      )}
    />
  );
}
