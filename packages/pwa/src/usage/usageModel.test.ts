import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import type { ParsedUsage, UsageAccount, UsageWindow } from './parseUsage.js';
import {
  accountName,
  barWidth,
  formatCost,
  formatPercent,
  formatTokens,
  headerSubtitle,
  totalTokens,
  usageTone,
  windowGroups,
} from './usageModel.js';

const EMPTY: ParsedUsage = { windows: [], accounts: [], extras: [], unparsed: '' };

describe('usageTone', () => {
  it('is normal below 80%, warning from 80%, critical from 95%', () => {
    expect(usageTone(0)).toBe('normal');
    expect(usageTone(79.99)).toBe('normal');
    expect(usageTone(80)).toBe('warning');
    expect(usageTone(94.99)).toBe('warning');
    expect(usageTone(95)).toBe('critical');
    expect(usageTone(100)).toBe('critical');
  });

  it('a window without a percentage is normal', () => {
    expect(usageTone(null)).toBe('normal');
  });
});

describe('accountName', () => {
  it('joins provider and plan, then the account label', () => {
    expect(accountName({ id: 'a', provider: 'Openai Codex', plan: 'plus', label: 'user@example.com' })).toBe(
      'Openai Codex plus · user@example.com',
    );
  });

  it('a label alone is the name (claude plan line)', () => {
    expect(accountName({ id: 'claude', label: 'Claude team subscription' })).toBe('Claude team subscription');
  });

  it('a provider without a plan is still one line', () => {
    const account: UsageAccount = { id: 'c', provider: 'Cursor', label: 'user@example.com' };
    expect(accountName(account)).toBe('Cursor · user@example.com');
  });
});

describe('headerSubtitle', () => {
  it('shows the one account', () => {
    expect(headerSubtitle([{ id: 'claude', label: 'Claude team subscription' }])).toBe('Claude team subscription');
  });

  it('counts several accounts', () => {
    const accounts: UsageAccount[] = [
      { id: '1', label: 'a@example.com' },
      { id: '2', label: 'b@example.com' },
    ];
    expect(headerSubtitle(accounts)).toBe('2 contas');
  });

  it('is null when the reply names no account', () => {
    expect(headerSubtitle([])).toBeNull();
  });
});

describe('windowGroups', () => {
  const win = (label: string, account?: string): UsageWindow =>
    account === undefined ? { label, usedPercent: 10 } : { label, usedPercent: 10, account };

  it('one group with no account when the reply has one account only and no account on the windows', () => {
    const usage: ParsedUsage = { ...EMPTY, windows: [win('5 horas'), win('Semanal')] };
    expect(windowGroups(usage)).toEqual([{ account: null, windows: usage.windows }]);
  });

  it('one group per account that has windows, in account order', () => {
    const accounts: UsageAccount[] = [
      { id: 'x', provider: 'Cursor', label: 'a@example.com' },
      { id: 'y', provider: 'Openai Codex', label: 'a@example.com', plan: 'plus' },
      { id: 'z', label: 'empty account' },
    ];
    const usage: ParsedUsage = {
      ...EMPTY,
      accounts,
      windows: [win('5 horas', 'y'), win('Mensal', 'x'), win('7 dias', 'y')],
    };
    const groups = windowGroups(usage);
    expect(groups.map((group) => group.account?.id)).toEqual(['x', 'y']);
    expect(groups[1]?.windows.map((window) => window.label)).toEqual(['5 horas', '7 dias']);
  });

  it('windows whose account is unknown go into a group without an account', () => {
    const usage: ParsedUsage = { ...EMPTY, accounts: [{ id: 'x', label: 'x' }], windows: [win('5 horas', 'missing')] };
    expect(windowGroups(usage)).toEqual([{ account: null, windows: usage.windows }]);
  });
});

describe('formatPercent and barWidth', () => {
  it('rounds the displayed percentage', () => {
    expect(formatPercent(51.36)).toBe('51%');
    expect(formatPercent(90)).toBe('90%');
  });

  it('clamps the bar width between 0 and 100', () => {
    expect(barWidth(-5)).toBe(0);
    expect(barWidth(42.5)).toBe(42.5);
    expect(barWidth(130)).toBe(100);
    expect(barWidth(null)).toBe(0);
  });
});

describe('formatCost', () => {
  it('formats dollars in pt-BR with the US$ prefix', () => {
    expect(formatCost(0.42)).toMatch(/^US\$\s0,42$/);
    expect(formatCost(0)).toMatch(/^US\$\s0,00$/);
  });
});

describe('formatTokens', () => {
  it('keeps small counts as they are', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatTokens(1200)).toMatch(/^1,2\s?mil$/);
    expect(formatTokens(2_100_000)).toMatch(/^2,1\s?mi$/);
  });
});

describe('totalTokens', () => {
  it('adds the four counts', () => {
    expect(totalTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toBe(10);
  });
});

describe('in English', () => {
  it('counts several accounts', () => {
    setLanguage('en');
    expect(headerSubtitle([{ id: '1', label: 'a@example.com' }, { id: '2', label: 'b@example.com' }])).toBe('2 accounts');
  });

  it('formats cost and token counts with the language of the app', () => {
    setLanguage('en');
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1200)).toBe('1.2K');
    expect(formatTokens(2_100_000)).toBe('2.1M');
  });
});
