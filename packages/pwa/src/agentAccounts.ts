import type { AgentAccount } from '@nanachi/shared';
import { formatRelativeTime } from './relativeTime.js';

/** Cor da bolinha de status: ok = verde, warn = amarelo, muted = cinza. */
export type AccountTone = 'ok' | 'warn' | 'muted';

export interface AccountView {
  statusLabel: string;
  tone: AccountTone;
  /** Texto de ajuda quando é preciso agir (só deslogado). */
  help: string | null;
}

export const LOGIN_HELP = 'Faça login no terminal do PC (ex.: claude, codex login, agy).';

/** Rótulo, cor e ajuda de um estado de conta. */
export function accountView(account: Pick<AgentAccount, 'status'>): AccountView {
  switch (account.status) {
    case 'logged_in':
      return { statusLabel: 'Logado', tone: 'ok', help: null };
    case 'logged_out':
      return { statusLabel: 'Deslogado', tone: 'warn', help: LOGIN_HELP };
    case 'unknown':
      return { statusLabel: 'Não verificado', tone: 'muted', help: null };
  }
}

/** "Verificado há 2 min", "Verificado agora", ou a data, conforme `formatRelativeTime`. */
export function checkedText(checkedAt: number, now: number): string {
  return `Verificado ${formatRelativeTime(checkedAt, now)}`;
}
