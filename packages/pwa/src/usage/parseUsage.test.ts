import { describe, expect, it } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { parseUsage } from './parseUsage.js';

const ESC = '\u001b';

/** Synthetic claude `/usage` reply, same structure as the real one (markdown, bars in backticks, two tables). */
const CLAUDE_TEXT = `## Usage

> Claude team subscription usage

### Limits

**5-hour limit** — **10%** · Resets Nov 4, 12:30 PM GMT-3

\`██░░░░░░░░░░░░░░░░░░\`

**Weekly · all models** — **71%** · Resets Nov 4, 11:00 PM GMT-3

\`██████████████░░░░░░\`

---

### This session

| Cost | API time | Active |
|:--|:--|:--|
| $0.42 | 3m 10s | 14m |

| Breakdown | Tokens |
|:--|--:|
| Input | 1.2k |
| Output | 35.4k |
| Cache read | 2.1M |
| Cache write | 180k |

---

### What’s using your limits?

> Approximate, overlapping measures · this machine only · excludes claude.ai

**Last 24h** · 3567 requests · 7 sessions

- **81%** Start fresh when you switch tasks · run /clear
`;

/**
 * Synthetic omp `/usage` reply: a code block with ANSI colours in the bars. Two providers, one account
 * (same mail in both), a model list that must be dropped, and a note line the parser does not know.
 */
const OMP_TEXT = `\`\`\`
Usage (1s ago)

Cursor
  Models with usage data
    cursor/composer-2.5
    cursor/gpt-5.5
- Cursor Models — Monthly
  account@example.com: 51.36% used (48.6% left)
  [${ESC}[38;2;0;180;255m██████████████${ESC}[39m░░░░░░░░░░] 51%
  resets in 14d
- Other Models — Monthly
  account@example.com: 0.11 usd used (99.5% left)
  [░░░░░░░░░░░░░░░░░░░░░░░░] 1%
  resets in 14d

Openai Codex
  Models with usage data
    openai-codex/gpt-5.6-sol
- account@example.com · plan: plus: 1 saved rate-limit reset — available — /usage reset to spend
  soonest expires in 28d (2026-12-01)
- 5 hours
  account@example.com · plan: plus: 90.00% used (10.0% left)  ← in use by this session
  [${ESC}[38;2;0;180;255m███████████████████████${ESC}[39m░] 90%
  resets in 2h
- 7 days
  account@example.com · plan: plus: 14.00% used (86.0% left)  ← in use by this session
  [███░░░░░░░░░░░░░░░░░░░░░] 14%
  resets in 7d
\`\`\`
`;

/** Synthetic codex `/status` reply: bold keys, one limit left per window (not used). */
const CODEX_TEXT = `**Model:** gpt-6.1-sol[high]
**Directory:** C:/Projects/example
**Approval:** on-request
**Sandbox:** workspace-write
**Account:** ChatGPT plus (user@example.com)
**Session:** \`01a1a493-0000-7000-8000-000000000000\`

**Token usage:** data not available yet
**Context window:** data not available yet
**codex 5h limit:** 9% left (resets 02:20)
**codex Weekly limit:** 86% left (resets 21:20 on Nov 10)
**codex Credits:** 0
`;

describe('parseUsage: claude', () => {
  const usage = parseUsage('claude', CLAUDE_TEXT);

  it('reads the two limit windows with their percentages and reset texts', () => {
    expect(usage.windows).toEqual([
      { label: '5 horas', usedPercent: 10, resetsAt: 'Nov 4, 12:30 PM GMT-3', account: 'claude' },
      { label: 'Semanal', usedPercent: 71, resetsAt: 'Nov 4, 11:00 PM GMT-3', account: 'claude' },
    ]);
  });

  it('reads the plan line as the account', () => {
    expect(usage.accounts).toEqual([{ id: 'claude', label: 'Claude team subscription' }]);
  });

  it('reads the session cost, tokens and active time', () => {
    expect(usage.session).toEqual({
      costUsd: 0.42,
      durationText: '14m',
      tokens: { input: 1200, output: 35400, cacheRead: 2100000, cacheWrite: 180000 },
    });
    expect(usage.extras).toEqual([{ label: 'Tempo de API', value: '3m 10s' }]);
  });

  it('keeps the "what is using your limits" section as unparsed text for the details', () => {
    expect(usage.unparsed).toContain('### What’s using your limits?');
    expect(usage.unparsed).toContain('**Last 24h**');
    expect(usage.unparsed).not.toContain('5-hour limit');
    expect(usage.unparsed).not.toContain('This session');
  });

  it('has no model line in the claude reply', () => {
    expect(usage.model).toBeUndefined();
  });

  it('a limit without a percentage keeps the reset and leaves usedPercent null', () => {
    const text = '### Limits\n\n**5-hour limit** — Resets Nov 4, 12:30 PM\n';
    expect(parseUsage('claude', text).windows).toEqual([
      { label: '5 horas', usedPercent: null, resetsAt: 'Nov 4, 12:30 PM' },
    ]);
  });

  it('a limit at 100% without a reset keeps the percentage and has no resetsAt', () => {
    const text = '### Limits\n\n**Weekly · all models** — **100%**\n';
    const [window] = parseUsage('claude', text).windows;
    expect(window).toEqual({ label: 'Semanal', usedPercent: 100 });
    expect(window).not.toHaveProperty('resetsAt');
  });

  it('a model-specific weekly limit keeps the model in its label', () => {
    const text = '### Limits\n\n**Weekly · Opus** — **33%** · Resets Nov 9, 9:00 AM\n';
    expect(parseUsage('claude', text).windows[0]).toMatchObject({ label: 'Semanal · Opus', usedPercent: 33 });
  });
});

/**
 * Claude Code's own `/usage` text: plain lines, no headings. The agent sends it when its markdown replacement does not
 * arrive in time (the replacement has a 5 s cap, and a cold agent is slower). The transcript keeps it inside
 * `<local-command-stdout>`. Same lines as the real reply; the numbers and the zones are made up.
 */
const CLAUDE_NATIVE_TEXT = `<local-command-stdout>You are currently using your subscription to power your Claude Code usage

Current session: 42% used · resets Nov 5, 11:30pm (UTC)
Current week (all models): 17% used · resets Nov 11, 11pm (UTC)

What's contributing to your usage?
Approximate · sessions on this machine only · shares overlap

Last 24h · 1200 requests · 3 sessions
  100%  Give "general-purpose" subagents a cheaper model
  Top MCP servers: example-server 1%

Last 7d · 9000 requests · 12 sessions
  88%  Start fresh when you switch tasks · run /clear
</local-command-stdout>`;

describe('parseUsage: claude, plain text', () => {
  const usage = parseUsage('claude', CLAUDE_NATIVE_TEXT);

  it('reads the session and weekly limits with their percentages and reset texts', () => {
    expect(usage.windows).toEqual([
      { label: '5 horas', usedPercent: 42, resetsAt: 'Nov 5, 11:30pm (UTC)' },
      { label: 'Semanal', usedPercent: 17, resetsAt: 'Nov 11, 11pm (UTC)' },
    ]);
  });

  it('has no account, because the plain reply has no plan line', () => {
    expect(usage.accounts).toEqual([]);
    expect(usage.windows.every((window) => window.account === undefined)).toBe(true);
  });

  it('keeps the contributions text as unparsed details, without the wrapper or the intro line', () => {
    expect(usage.unparsed).toContain("What's contributing to your usage?");
    expect(usage.unparsed).toContain('Last 24h');
    expect(usage.unparsed).not.toContain('<local-command-stdout>');
    expect(usage.unparsed).not.toContain('You are currently using');
    expect(usage.unparsed).not.toContain('42% used');
  });

  it('a model-specific week keeps the model in its label', () => {
    const text = 'Current week (Opus): 9% used · resets Nov 11, 11pm (UTC)';
    expect(parseUsage('claude', text).windows).toEqual([
      { label: 'Semanal · Opus', usedPercent: 9, resetsAt: 'Nov 11, 11pm (UTC)' },
    ]);
  });

  it('a limit without a reset keeps the percentage and has no resetsAt', () => {
    const [window] = parseUsage('claude', 'Current session: 100% used').windows;
    expect(window).toEqual({ label: '5 horas', usedPercent: 100 });
    expect(window).not.toHaveProperty('resetsAt');
  });

  it('a reply with only the intro line stays unparsed text', () => {
    const text = 'You are currently using your subscription to power your Claude Code usage';
    const usage = parseUsage('claude', text);
    expect(usage.windows).toEqual([]);
    expect(usage.unparsed).toBe(text);
  });

  it('a markdown reply still reads with the markdown parser (no plain-text limits added to it)', () => {
    const usage = parseUsage('claude', CLAUDE_TEXT);
    expect(usage.windows.map((window) => window.usedPercent)).toEqual([10, 71]);
  });
});

describe('parseUsage: omp', () => {
  const usage = parseUsage('omp', OMP_TEXT);

  it('reads one window per usage block, with the account and the "in use" mark', () => {
    expect(usage.windows).toEqual([
      { label: 'Cursor Models · Mensal', usedPercent: 51.36, resetsAt: 'em 14d', account: 'Cursor|account@example.com' },
      { label: '5 horas', usedPercent: 90, resetsAt: 'em 2h', account: 'Openai Codex|account@example.com', inUse: true },
      { label: '7 dias', usedPercent: 14, resetsAt: 'em 7d', account: 'Openai Codex|account@example.com', inUse: true },
    ]);
  });

  it('groups by provider and account, and reads the plan', () => {
    expect(usage.accounts).toEqual([
      { id: 'Cursor|account@example.com', provider: 'Cursor', label: 'account@example.com' },
      { id: 'Openai Codex|account@example.com', provider: 'Openai Codex', label: 'account@example.com', plan: 'plus' },
    ]);
  });

  it('drops the long "models with usage data" lists', () => {
    expect(usage.unparsed).not.toContain('composer-2.5');
    expect(usage.unparsed).not.toContain('gpt-5.6-sol');
    expect(usage.unparsed).not.toContain('Models with usage data');
  });

  it('a usd spend (no percentage) becomes an extra, not a window', () => {
    expect(usage.extras).toEqual([{ label: 'Other Models · Mensal', value: '0.11 USD' }]);
    expect(usage.windows.some((window) => window.label.startsWith('Other'))).toBe(false);
  });

  it('keeps the lines it does not understand (the rate-limit note) as unparsed text', () => {
    expect(usage.unparsed).toContain('saved rate-limit reset');
    expect(usage.unparsed).toContain('soonest expires in 28d');
    expect(usage.unparsed).not.toContain('```');
    expect(usage.unparsed).not.toContain('Usage (1s ago)');
  });

  it('never leaves escape codes in any field', () => {
    const everything = JSON.stringify(usage);
    expect(everything).not.toContain(ESC);
  });

  it('a bar with only a percentage (no "% used" line) uses the bar percentage', () => {
    const text = '- 5 hours\n  [███░░░] 73%\n  resets in 3h\n';
    expect(parseUsage('omp', text).windows).toEqual([{ label: '5 horas', usedPercent: 73, resetsAt: 'em 3h' }]);
  });

  it('a bar that is only colour codes, with no percentage, gives a null percentage and no window', () => {
    const text = `- 5 hours\n  ${ESC}[32m${ESC}[39m\n  resets in 3h\n`;
    const usage = parseUsage('omp', text);
    expect(usage.windows).toEqual([]);
    expect(usage.unparsed).toContain('5 hours');
  });
});

describe('parseUsage: codex', () => {
  const usage = parseUsage('codex', CODEX_TEXT);

  it('reads the model', () => {
    expect(usage.model).toBe('gpt-6.1-sol[high]');
  });

  it('turns "left" into "used" and maps the windows to 5 horas and Semanal', () => {
    expect(usage.windows).toEqual([
      { label: '5 horas', usedPercent: 91, resetsAt: '02:20', account: 'ChatGPT plus (user@example.com)' },
      { label: 'Semanal', usedPercent: 14, resetsAt: '21:20 on Nov 10', account: 'ChatGPT plus (user@example.com)' },
    ]);
  });

  it('reads the account, provider and plan', () => {
    expect(usage.accounts).toEqual([
      { id: 'ChatGPT plus (user@example.com)', provider: 'ChatGPT', plan: 'plus', label: 'user@example.com' },
    ]);
  });

  it('shows the not-yet-available token and context lines as extras, and the credits', () => {
    expect(usage.extras).toEqual([
      { label: 'Tokens', value: 'indisponível' },
      { label: 'Janela de contexto', value: 'indisponível' },
      { label: 'Créditos', value: '0' },
    ]);
  });

  it('drops the directory, approval, sandbox and session lines', () => {
    expect(usage.unparsed).toBe('');
    expect(JSON.stringify(usage)).not.toContain('C:/Projects');
  });
});

describe('parseUsage: fallback', () => {
  it('an unknown agent gives no windows and the whole text as unparsed', () => {
    const usage = parseUsage('gemini', CLAUDE_TEXT);
    expect(usage.windows).toEqual([]);
    expect(usage.accounts).toEqual([]);
    expect(usage.extras).toEqual([]);
    expect(usage.session).toBeUndefined();
    expect(usage.unparsed).toBe(CLAUDE_TEXT.trim());
  });

  it('a known agent with an unknown format keeps the text as unparsed', () => {
    const text = `Algo novo ${ESC}[1mnegrito${ESC}[0m\nsem percentuais`;
    const usage = parseUsage('omp', text);
    expect(usage.windows).toEqual([]);
    expect(usage.unparsed).toBe('Algo novo negrito\nsem percentuais');
  });

  it('a claude reply read as codex keeps the text (no codex lines matched)', () => {
    const usage = parseUsage('codex', CLAUDE_TEXT);
    expect(usage.windows).toEqual([]);
    expect(usage.unparsed).toBe(CLAUDE_TEXT.trim());
  });

  it('an empty reply gives an empty unparsed text', () => {
    const usage = parseUsage('claude', '   \n  ');
    expect(usage.windows).toEqual([]);
    expect(usage.unparsed).toBe('');
  });

  it('an agent name that is a JavaScript property name is not a parser', () => {
    const usage = parseUsage('constructor', 'texto');
    expect(usage.windows).toEqual([]);
    expect(usage.unparsed).toBe('texto');
  });
});

describe('parseUsage labels in English', () => {
  it('claude: 5 hours, Weekly, and the API time', () => {
    setLanguage('en');
    const usage = parseUsage('claude', CLAUDE_TEXT);
    expect(usage.windows.map((window) => window.label)).toEqual(['5 hours', 'Weekly']);
    expect(usage.windows.map((window) => window.resetsAt)).toEqual(['Nov 4, 12:30 PM GMT-3', 'Nov 4, 11:00 PM GMT-3']);
    expect(usage.extras).toEqual([{ label: 'API time', value: '3m 10s' }]);
  });

  it('claude: a weekly limit for one model keeps the model name', () => {
    setLanguage('en');
    const text = '### Limits\n\n**Weekly · Opus** — **33%**\n';
    expect(parseUsage('claude', text).windows[0]).toMatchObject({ label: 'Weekly · Opus', usedPercent: 33 });
  });

  it('omp: window names, monthly, and "in" before the reset text the agent prints', () => {
    setLanguage('en');
    const usage = parseUsage('omp', OMP_TEXT);
    expect(usage.windows.map((window) => [window.label, window.resetsAt])).toEqual([
      ['Cursor Models · Monthly', 'in 14d'],
      ['5 hours', 'in 2h'],
      ['7 days', 'in 7d'],
    ]);
    expect(usage.extras).toEqual([{ label: 'Other Models · Monthly', value: '0.11 USD' }]);
  });

  it('omp: one hour and one day are singular', () => {
    setLanguage('en');
    const text = '- 1 hour\n  [███░░░] 20%\n- 1 day\n  [███░░░] 30%\n';
    expect(parseUsage('omp', text).windows.map((window) => window.label)).toEqual(['1 hour', '1 day']);
  });

  it('codex: labels, and "unavailable" for what the agent has not reported yet', () => {
    setLanguage('en');
    const usage = parseUsage('codex', CODEX_TEXT);
    expect(usage.windows.map((window) => window.label)).toEqual(['5 hours', 'Weekly']);
    expect(usage.extras).toEqual([
      { label: 'Tokens', value: 'unavailable' },
      { label: 'Context window', value: 'unavailable' },
      { label: 'Credits', value: '0' },
    ]);
  });
});
