import type { SessionStatus } from '@nanachi/shared';
import { t } from './i18n/index.js';

/** Title the daemon gives a session until the first prompt (a PTY session never gets another). Data from the daemon: compare, do not show. */
export const DEFAULT_SESSION_TITLE = 'Nova sessão';

/**
 * Text of the status pill. For a terminal (PTY), "running" is "Em execução" / "Running", not "Trabalhando" / "Working",
 * and a stopped terminal is "Encerrado" (there is no conversation to resume).
 */
export function sessionStatusText(status: SessionStatus, kind: 'acp' | 'pty'): string {
  if (status === 'running' && kind === 'pty') return t('common:sessionStatus.runningTerminal');
  if (status === 'stopped' && kind === 'pty') return t('common:sessionStatus.stoppedTerminal');
  return t(`common:sessionStatus.${status}`);
}

/**
 * Title to show. The placeholder title the daemon gives a new session is translated; any other title is the
 * session's own text (the first prompt, or what the agent named it) and is shown as it is.
 */
export function displaySessionTitle(title: string): string {
  return title === DEFAULT_SESSION_TITLE ? t('common:sessionTitle.default') : title;
}

/**
 * Title to show. A terminal without a title (the default) becomes "<agent> · terminal", because there is no first
 * prompt to name the session.
 */
export function sessionTitle(
  session: { title: string; kind: 'acp' | 'pty' },
  agentLabel: string,
): string {
  if (session.kind === 'pty' && session.title === DEFAULT_SESSION_TITLE) {
    return t('common:sessionTitle.terminal', { agent: agentLabel });
  }
  return displaySessionTitle(session.title);
}
