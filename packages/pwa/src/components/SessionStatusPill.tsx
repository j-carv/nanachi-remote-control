import type { SessionStatus } from '@nanachi/shared';
import { sessionStatusText } from '../sessionText.js';

interface SessionStatusPillProps {
  status: SessionStatus;
  /** Sessão de terminal (PTY) mostra "Em execução" em vez de "Trabalhando". */
  kind?: 'acp' | 'pty';
}

export function SessionStatusPill({ status, kind = 'acp' }: SessionStatusPillProps) {
  return <span className={`pill pill-${status}`}>{sessionStatusText(status, kind)}</span>;
}
