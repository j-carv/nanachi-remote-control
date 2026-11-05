import type { ParsedUsage, UsageAccount, UsageTokens, UsageWindow } from './parseUsage.js';

/** Bar and number tone: `warning` from 80% used, `critical` from 95%. Only the bar changes colour. */
export type UsageTone = 'normal' | 'warning' | 'critical';

export function usageTone(usedPercent: number | null): UsageTone {
  if (usedPercent === null) return 'normal';
  if (usedPercent >= 95) return 'critical';
  if (usedPercent >= 80) return 'warning';
  return 'normal';
}

/** "Openai Codex plus · user@example.com", or the label alone when there is no provider or plan. */
export function accountName(account: UsageAccount): string {
  const head = [account.provider, account.plan].filter((part) => part !== undefined && part !== '').join(' ');
  return head === '' ? account.label : `${head} · ${account.label}`;
}

/** The muted line under "Uso do <agente>": the account when there is one, a count when there are several. */
export function headerSubtitle(accounts: readonly UsageAccount[]): string | null {
  const [only] = accounts;
  if (accounts.length === 1 && only !== undefined) return accountName(only);
  if (accounts.length === 0) return null;
  return `${accounts.length} contas`;
}

export interface WindowGroup {
  /** `null` for the windows that belong to no known account. */
  account: UsageAccount | null;
  windows: UsageWindow[];
}

/** Windows grouped by account, in the account order of the reply. Accounts without windows are left out. */
export function windowGroups(usage: ParsedUsage): WindowGroup[] {
  const groups: WindowGroup[] = [];
  for (const account of usage.accounts) {
    const windows = usage.windows.filter((window) => window.account === account.id);
    if (windows.length > 0) groups.push({ account, windows });
  }
  const orphans = usage.windows.filter((window) => !usage.accounts.some((account) => account.id === window.account));
  if (orphans.length > 0) groups.push({ account: null, windows: orphans });
  return groups;
}

/** The big number on a card: whole percent. */
export function formatPercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

/** Width of the progress bar in percent, clamped; a window without a percentage has an empty bar. */
export function barWidth(usedPercent: number | null): number {
  if (usedPercent === null) return 0;
  return Math.min(100, Math.max(0, usedPercent));
}

const CURRENCY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' });
const COMPACT = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

export function formatCost(usd: number): string {
  return CURRENCY.format(usd);
}

/** Token counts: exact below a thousand, compact above ("1,2 mil", "2,1 mi"). */
export function formatTokens(count: number): string {
  return count < 1000 ? String(count) : COMPACT.format(count);
}

export function totalTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}
