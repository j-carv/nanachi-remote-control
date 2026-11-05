import type { AgentAccount, AgentProfile, SessionStatus } from '@nanachi/shared';
import { t } from './i18n/index.js';
import { formatRelativeTime } from './relativeTime.js';

/** Cor da bolinha de status: ok = verde, warn = amarelo, muted = cinza. */
export type AccountTone = 'ok' | 'warn' | 'muted';

export interface AccountView {
  statusLabel: string;
  tone: AccountTone;
  /** Texto de ajuda quando é preciso agir (só deslogado). */
  help: string | null;
}

/** What to do when an agent is signed out: the login happens in the PC's terminal. */
export function loginHelp(): string {
  return t('accounts:status.loginHelp');
}

/** Rótulo, cor e ajuda de um estado de conta. */
export function accountView(account: Pick<AgentAccount, 'status'>): AccountView {
  switch (account.status) {
    case 'logged_in':
      return { statusLabel: t('accounts:status.logged_in'), tone: 'ok', help: null };
    case 'logged_out':
      return { statusLabel: t('accounts:status.logged_out'), tone: 'warn', help: loginHelp() };
    case 'unknown':
      return { statusLabel: t('accounts:status.unknown'), tone: 'muted', help: null };
  }
}

/** "Verificado há 2 min" / "Checked 2 min ago", "Verificado agora" / "Checked now", or the date, as `formatRelativeTime` says. */
export function checkedText(checkedAt: number, now: number): string {
  return t('accounts:section.checked', { time: formatRelativeTime(checkedAt, now) });
}

/** Id of the principal account of every agent (the agent's normal home). It has no row of its own in the daemon. */
export const PRINCIPAL_ACCOUNT_ID = 'default';

export interface ProfileView {
  statusLabel: string;
  tone: AccountTone;
  /** The line under the account name: e-mail and detail when logged in, otherwise what the status is. */
  subtitle: string;
}

/** What a row of "Contas dos agentes" shows for one account of an agent. */
export function profileView(profile: Pick<AgentProfile, 'status' | 'account' | 'detail'>): ProfileView {
  const { statusLabel, tone } = accountView(profile);
  switch (profile.status) {
    case 'logged_in': {
      const parts = [profile.account, profile.detail].filter((part): part is string => part !== null);
      return { statusLabel, tone, subtitle: parts.length > 0 ? parts.join(' · ') : statusLabel };
    }
    case 'logged_out':
      return { statusLabel, tone, subtitle: statusLabel };
    case 'unknown':
      return { statusLabel, tone, subtitle: profile.detail ?? statusLabel };
  }
}

export type ProfileAction = 'use' | 'login' | 'rename' | 'remove';

/**
 * The actions of the sheet that a row opens, in order. The principal can log in again and become the account of new
 * sessions, but it has no editable name and is never removed (the daemon answers 400 to both).
 */
export function profileActions(profile: Pick<AgentProfile, 'isDefault' | 'active'>): ProfileAction[] {
  const actions: ProfileAction[] = [];
  if (!profile.active) actions.push('use');
  actions.push('login');
  if (!profile.isDefault) actions.push('rename', 'remove');
  return actions;
}

export interface LoginReloads {
  /** A login sheet opened. */
  started(): void;
  /** The login worked: the list is read again right away. */
  succeeded(): void;
  /** The sheet closed: the list is read again unless `succeeded` already did it for this login. */
  closed(): void;
}

/**
 * When "Contas dos agentes" reads its list again around one login: once as soon as the login succeeds (the sheet stays
 * open for a moment after that), and on close only if that did not happen, since a login that was cancelled or failed
 * can still have changed a status. A success followed by the close reads the list once, not twice.
 */
export function createLoginReloads(reload: () => void): LoginReloads {
  let reloaded = false;
  return {
    started() {
      reloaded = false;
    },
    succeeded() {
      reloaded = true;
      reload();
    },
    closed() {
      const already = reloaded;
      reloaded = false;
      if (!already) reload();
    },
  };
}

/** Text of the confirmation to remove an extra account. */
export function removeAccountText(agentLabel: string, accountLabel: string): string {
  return t('accounts:remove.text', { account: accountLabel, agent: agentLabel });
}

const LABEL_MAX = 40;

/** Problem with the name of an account, or null. The daemon takes 1 to 40 characters after trimming. */
export function validateAccountLabel(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return t('accounts:validation.empty');
  if (trimmed.length > LABEL_MAX) return t('accounts:validation.tooLong', { max: LABEL_MAX });
  return null;
}

/** The accounts of one agent when there is a choice to make: at least two, on a daemon that supports them. */
export interface AccountSelector {
  profiles: readonly AgentProfile[];
  /** The account new sessions use. */
  activeId: string;
}

/** The selector of the new-session and session-configuration sheets, or null when it is not shown. */
export function accountSelectorFor(accounts: readonly AgentAccount[] | null, agentId: string): AccountSelector | null {
  const entry = accounts?.find((account) => account.agentId === agentId);
  if (entry === undefined || !entry.supportsAccounts || entry.profiles.length < 2) return null;
  const active = entry.profiles.find((profile) => profile.active);
  return { profiles: entry.profiles, activeId: active?.id ?? PRINCIPAL_ACCOUNT_ID };
}

/** The text of an option of the account select: the name, with the e-mail when another account has the same name. */
export function accountOptionLabel(profile: AgentProfile, profiles: readonly AgentProfile[]): string {
  const repeated = profiles.some((other) => other.id !== profile.id && other.label === profile.label);
  return repeated && profile.account !== null ? `${profile.label} · ${profile.account}` : profile.label;
}

function hasProfile(selector: AccountSelector, accountId: string): boolean {
  return selector.profiles.some((profile) => profile.id === accountId);
}

/** The account a new session is created with: the user's choice if it still exists, else the active one. */
export function newSessionAccount(selector: AccountSelector, chosen: string | null): string {
  return chosen !== null && hasProfile(selector, chosen) ? chosen : selector.activeId;
}

/** The account a session runs on, as an id of the selector. `null` is the principal; a removed account falls back to it. */
export function sessionAccount(selector: AccountSelector, accountId: string | null): string {
  const id = accountId ?? PRINCIPAL_ACCOUNT_ID;
  return hasProfile(selector, id) ? id : PRINCIPAL_ACCOUNT_ID;
}

/** The line under the account row while the agent is busy. */
export function accountLockedHint(): string {
  return t('accounts:select.lockedHint');
}

/** The daemon refuses to move a session while its agent is starting, working or waiting for a permission (409). */
export function accountChangeLocked(status: SessionStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'awaiting_permission';
}

export interface SessionAccountInfo {
  label: string;
  email: string | null;
}

/** Name and e-mail of the account a session runs on, for agents that have accounts. Null when there is nothing to show. */
export function sessionAccountInfo(
  accounts: readonly AgentAccount[] | null,
  agentId: string,
  accountId: string | null,
): SessionAccountInfo | null {
  const entry = accounts?.find((account) => account.agentId === agentId);
  if (entry === undefined || !entry.supportsAccounts) return null;
  const id = accountId ?? PRINCIPAL_ACCOUNT_ID;
  const profile = entry.profiles.find((candidate) => candidate.id === id);
  return profile === undefined ? null : { label: profile.label, email: profile.account };
}
