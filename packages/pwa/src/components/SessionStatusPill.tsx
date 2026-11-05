import type { LucideIcon } from 'lucide-react';
import {
  CircleDashed,
  CircleExclamationPoint,
  CircleSlash,
  LoaderCircle,
  ShieldExclamationPoint,
} from 'lucide-react';
import type { SessionStatus } from '@nanachi/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { sessionStatusText } from '../sessionText.js';
import { TONE_TEXT, type StatusTone } from './StatusDot.js';

interface StatusVisual {
  tone: StatusTone;
  icon: LucideIcon;
  spin: boolean;
}

const STATUS_VISUAL: Record<SessionStatus, StatusVisual> = {
  starting: { tone: 'muted', icon: LoaderCircle, spin: true },
  idle: { tone: 'muted', icon: CircleDashed, spin: false },
  running: { tone: 'running', icon: LoaderCircle, spin: true },
  awaiting_permission: { tone: 'attention', icon: ShieldExclamationPoint, spin: false },
  stopped: { tone: 'muted', icon: CircleSlash, spin: false },
  error: { tone: 'danger', icon: CircleExclamationPoint, spin: false },
};

interface SessionStatusPillProps {
  status: SessionStatus;
  /** Sessão de terminal (PTY) mostra "Em execução" em vez de "Trabalhando". */
  kind?: 'acp' | 'pty';
}

/** Estado da sessão: ícone colorido (o único tom do status) + texto em cinza escuro. */
export function SessionStatusPill({ status, kind = 'acp' }: SessionStatusPillProps) {
  const visual = STATUS_VISUAL[status];
  const Icon = visual.icon;
  return (
    <Badge data-status={status} className="gap-1.5 bg-secondary px-2 py-1 text-xs text-foreground">
      <Icon
        aria-hidden="true"
        className={cn('size-3.5', TONE_TEXT[visual.tone], visual.spin && 'animate-spin motion-reduce:animate-none')}
      />
      {sessionStatusText(status, kind)}
    </Badge>
  );
}
