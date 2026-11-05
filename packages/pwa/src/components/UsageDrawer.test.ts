import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { parseUsage } from '../usage/parseUsage.js';
import type { SessionAccountInfo } from '../agentAccounts.js';
import {
  startUsageRequest,
  type ResetsPanel,
  type UsageState,
  UsageAccountLine,
  UsageContent,
  updatedLabel,
} from './UsageDrawer.js';

const NOW = new Date(2026, 10, 4, 12, 0).getTime();
const MINUTE_MS = 60_000;

const noop = () => undefined;

interface Pending {
  resolve(value: UsageResponse): void;
  reject(error: unknown): void;
}

/** Fake client whose requests stay pending until the test settles them, in call order. */
function fakeClient() {
  const pending: Pending[] = [];
  const client = {
    fetchSessionUsage: () =>
      new Promise<UsageResponse>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  };
  return { client, pending };
}

/** Lets the promise callbacks of settled requests run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const USAGE: UsageResponse = { agent: 'omp', text: '5 hours: 20% used', fetchedAt: NOW };

/** A ready state built the way the drawer builds it: the reply parsed for its agent. */
function ready(agent: string, text: string, cached = false): UsageState {
  return { status: 'ready', text, fetchedAt: NOW, cached, usage: parseUsage(agent, text) };
}

const CLAUDE_TEXT = `## Usage

> Claude team subscription usage

### Limits

**5-hour limit** — **10%** · Resets Nov 4, 12:30 PM GMT-3

**Weekly · all models** — **96%** · Resets Nov 4, 11:00 PM GMT-3

### What’s using your limits?

**Last 24h** · 3567 requests
`;

const OMP_TEXT = [
  '```',
  'Usage (1s ago)',
  '',
  'Openai Codex',
  '  Models with usage data',
  '    openai-codex/gpt-5.6-sol',
  '- 5 hours',
  '  user@example.com · plan: plus: 90.00% used (10.0% left)  ← in use by this session',
  '  [\u001b[38;2;0;180;255m██████████████████████\u001b[39m░░] 90%',
  '  resets in 2h',
  '```',
].join('\n');

describe('startUsageRequest', () => {
  it('reports loading first, then ready with the reply parsed for its agent', async () => {
    const { client, pending } = fakeClient();
    const states: UsageState[] = [];
    startUsageRequest(client, 's-1', (state) => states.push(state));
    expect(states).toEqual([{ status: 'loading' }]);

    pending[0]?.resolve(USAGE);
    await settle();
    expect(states.at(-1)).toEqual({
      status: 'ready',
      text: USAGE.text,
      fetchedAt: NOW,
      cached: false,
      usage: parseUsage('omp', USAGE.text),
    });
  });

  it('a cached reply is marked cached', async () => {
    const { client, pending } = fakeClient();
    const states: UsageState[] = [];
    startUsageRequest(client, 's-1', (state) => states.push(state));

    pending[0]?.resolve({ ...USAGE, cached: true });
    await settle();
    expect(states.at(-1)).toMatchObject({ status: 'ready', cached: true });
  });

  it('reports the error object when the request fails', async () => {
    const { client, pending } = fakeClient();
    const states: UsageState[] = [];
    const error = new ApiError('unexpected', 409, null, 'session_not_active');
    startUsageRequest(client, 's-1', (state) => states.push(state));

    pending[0]?.reject(error);
    await settle();
    expect(states.at(-1)).toEqual({ status: 'error', error });
  });

  it('a reply that arrives after cancel (drawer closed) changes nothing', async () => {
    const { client, pending } = fakeClient();
    const states: UsageState[] = [];
    const cancel = startUsageRequest(client, 's-1', (state) => states.push(state));

    cancel();
    pending[0]?.resolve(USAGE);
    await settle();
    expect(states).toEqual([{ status: 'loading' }]);
  });

  it('a refresh drops the reply of the request it replaced', async () => {
    const { client, pending } = fakeClient();
    const first: UsageState[] = [];
    const second: UsageState[] = [];
    const cancelFirst = startUsageRequest(client, 's-1', (state) => first.push(state));

    cancelFirst();
    startUsageRequest(client, 's-1', (state) => second.push(state));
    pending[1]?.resolve({ ...USAGE, text: 'nova' });
    pending[0]?.resolve({ ...USAGE, text: 'antiga' });
    await settle();

    expect(first).toEqual([{ status: 'loading' }]);
    expect(second.at(-1)).toMatchObject({ status: 'ready', text: 'nova', fetchedAt: NOW });
  });
});

describe('updatedLabel', () => {
  it('uses the relative time of the last reply', () => {
    expect(updatedLabel(NOW, NOW)).toBe('Atualizado agora');
    expect(updatedLabel(NOW - 5 * MINUTE_MS, NOW)).toBe('Atualizado há 5 min');
  });

  it('says when the reply came from the daemon cache', () => {
    expect(updatedLabel(NOW - 5 * MINUTE_MS, NOW, true)).toBe('Atualizado há 5 min · do cache');
  });
});

const render = (state: UsageState): string =>
  renderToStaticMarkup(createElement(UsageContent, { state, now: NOW, onRefresh: noop, onResume: noop }));

describe('UsageContent', () => {
  it('loading: skeleton with a label, and the refresh button disabled', () => {
    const html = render({ status: 'loading' });

    expect(html).toContain('aria-label="Carregando uso"');
    expect(html).toContain('aria-label="Atualizar uso"');
    expect(html).toMatch(/<button[^>]*aria-label="Atualizar uso"[^>]*disabled=""/);
    expect(html).not.toContain('Atualizado');
  });

  it('ready: one card per limit with its label, percentage and reset text', () => {
    const html = render(ready('claude', CLAUDE_TEXT));

    expect(html).toContain('5 horas');
    expect(html).toContain('>10%<');
    expect(html).toContain('Renova Nov 4, 12:30 PM GMT-3');
    expect(html).toContain('Semanal');
    expect(html).toContain('Atualizado agora');
    expect(html).not.toMatch(/<button[^>]*aria-label="Atualizar uso"[^>]*disabled=""/);
  });

  it('ready: the markdown of the reply is not shown as text (the cards replace it)', () => {
    const html = render(ready('claude', CLAUDE_TEXT));

    expect(html).not.toContain('**5-hour limit**');
    expect(html).not.toContain('## Usage');
  });

  it('ready: a window in use gets the "em uso" badge', () => {
    expect(render(ready('omp', OMP_TEXT))).toContain('em uso');
    expect(render(ready('claude', CLAUDE_TEXT))).not.toContain('em uso');
  });

  it('ready: a bar at 80% or more switches to the warning or destructive tone, and stays foreground below', () => {
    const omp = render(ready('omp', OMP_TEXT));
    expect(omp).toContain('bg-attention');
    expect(omp).not.toContain('bg-destructive');

    const claude = render(ready('claude', CLAUDE_TEXT));
    expect(claude).toContain('bg-foreground');
    expect(claude).toContain('bg-destructive');
    expect(claude).not.toContain('bg-attention');
  });

  it('ready: the unparsed text goes to a collapsed "Detalhes" section, closed when the cards show', () => {
    const html = render(ready('claude', CLAUDE_TEXT));

    expect(html).toContain('<summary');
    expect(html).toContain('Detalhes');
    expect(html).toContain('What’s using your limits?');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it('ready: "Detalhes" opens when nothing could be parsed, so the raw reply is visible', () => {
    const html = render(ready('omp', 'Algo novo sem percentuais'));

    expect(html).toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('Algo novo sem percentuais');
  });

  it('ready: ANSI codes from /usage never reach the markup', () => {
    const html = render(ready('omp', OMP_TEXT));

    expect(html).toContain('90%');
    expect(html).not.toContain('\u001b');
  });

  it('ready: a cached reply says so in the footer', () => {
    expect(render(ready('claude', CLAUDE_TEXT, true))).toContain('Atualizado agora · do cache');
  });

  it('ready with an empty reply says so', () => {
    expect(render(ready('claude', '  '))).toContain('O agente não devolveu nada.');
  });

  it('session_not_active: shows the resume message and a Retomar button', () => {
    const html = render({
      status: 'error',
      error: new ApiError('unexpected', 409, null, 'session_not_active'),
    });

    expect(html).toContain('Retome a sessão para ver o uso.');
    expect(html).toContain('>Retomar</button>');
  });

  it('other errors show their message and no Retomar button', () => {
    const html = render({
      status: 'error',
      error: new ApiError('unexpected', 409, null, 'session_busy'),
    });

    expect(html).toContain('O agente está ocupado; tente quando ele terminar.');
    expect(html).not.toContain('Retomar');
  });
});

describe('UsageContent: saved resets', () => {
  const RESET_ENTRY = {
    target: 'anthropic/1',
    accountLabel: 'fake@example.com',
    providerLabel: 'Anthropic',
    available: 2,
    usable: 1,
    expiresAt: null,
    note: null,
    active: true,
  };

  function renderWith(state: UsageState, resets?: ResetsPanel, refreshFailed?: { error: unknown } | null): string {
    return renderToStaticMarkup(
      createElement(UsageContent, { state, now: NOW, onRefresh: noop, onResume: noop, resets, refreshFailed }),
    );
  }

  const panel = (redeem: ResetsPanel['redeem'] = { status: 'idle' }): ResetsPanel => ({
    list: { status: 'ready', entries: [RESET_ENTRY], message: null },
    redeem,
    onRedeem: noop,
    onDismissRedeem: noop,
  });

  it('without a resets panel there is no section (agents without resets)', () => {
    const html = renderWith(ready('claude', CLAUDE_TEXT));
    expect(html).not.toContain('Resets salvos');
  });

  it('the section comes after the limit cards', () => {
    const html = renderWith(ready('omp', OMP_TEXT), panel());
    expect(html).toContain('Resets salvos');
    expect(html.indexOf('Resets salvos')).toBeGreaterThan(html.indexOf('>90%<'));
  });

  it('while the usage loads the section is not shown', () => {
    expect(renderWith({ status: 'loading' }, panel())).not.toContain('Resets salvos');
  });

  it('a usage error does not show the section either', () => {
    const html = renderWith({ status: 'error', error: new ApiError('network') }, panel());
    expect(html).not.toContain('Resets salvos');
  });

  it('an empty usage reply still shows the section', () => {
    const html = renderWith(ready('omp', '  '), panel());
    expect(html).toContain('O agente não devolveu nada.');
    expect(html).toContain('Resets salvos');
  });

  it('the refresh button is disabled while a redeem runs, and enabled otherwise', () => {
    const running = renderWith(ready('omp', OMP_TEXT), panel({ status: 'running', target: 'anthropic/1' }));
    expect(running).toMatch(/<button[^>]*aria-label="Atualizar uso"[^>]*disabled=""/);
    const idle = renderWith(ready('omp', OMP_TEXT), panel());
    expect(idle).not.toMatch(/<button[^>]*aria-label="Atualizar uso"[^>]*disabled=""/);
  });
});

describe('UsageContent: the reply of a redeem does not depend on the usage state', () => {
  const REPLY = { tone: 'success', message: 'Reset applied for fake@example.com (Anthropic).' } as const;
  const done = { status: 'done', result: REPLY } as const;
  const withReply = (): ResetsPanel => ({
    list: { status: 'loading' },
    redeem: done,
    onRedeem: noop,
    onDismissRedeem: noop,
  });
  const renderWith = (state: UsageState, resets: ResetsPanel | undefined, refreshFailed?: { error: unknown }): string =>
    renderToStaticMarkup(
      createElement(UsageContent, { state, now: NOW, onRefresh: noop, onResume: noop, resets, refreshFailed }),
    );

  it('usage error on a new open: the reply is still shown, once, with its close button', () => {
    const html = renderWith({ status: 'error', error: new ApiError('network') }, withReply());
    expect(html).toContain('Reset applied for fake@example.com (Anthropic).');
    expect(html.match(/data-slot="reset-result"/g)).toHaveLength(1);
    expect(html).toContain('data-slot="reset-result-dismiss"');
    expect(html).not.toContain('Resets salvos');
    expect(html).toContain('role="alert"');
  });

  it('usage loading: the reply is shown above the skeleton', () => {
    const html = renderWith({ status: 'loading' }, withReply());
    expect(html).toContain('data-slot="reset-result"');
    expect(html.indexOf('data-slot="reset-result"')).toBeLessThan(html.indexOf('aria-label="Carregando uso"'));
  });

  it('usage ready: the reply sits in the section, once', () => {
    const html = renderWith(ready('omp', OMP_TEXT), withReply());
    expect(html.match(/data-slot="reset-result"/g)).toHaveLength(1);
    expect(html.indexOf('Resets salvos')).toBeLessThan(html.indexOf('data-slot="reset-result"'));
  });

  it('no reply while idle or running, and none without a resets panel', () => {
    const idle: ResetsPanel = { ...withReply(), redeem: { status: 'idle' } };
    const running: ResetsPanel = { ...withReply(), redeem: { status: 'running', target: 'anthropic/1' } };
    expect(renderWith({ status: 'loading' }, idle)).not.toContain('data-slot="reset-result"');
    expect(renderWith({ status: 'loading' }, running)).not.toContain('data-slot="reset-result"');
    expect(renderWith({ status: 'loading' }, undefined)).not.toContain('data-slot="reset-result"');
  });
});

describe('UsageContent: a refresh that failed keeps the last usage', () => {
  const state = ready('omp', OMP_TEXT);

  it('shows the last good numbers and a small inline error saying they are old', () => {
    const html = renderToStaticMarkup(
      createElement(UsageContent, {
        state,
        now: NOW,
        onRefresh: noop,
        onResume: noop,
        refreshFailed: { error: new ApiError('agent_timeout', 504, null, 'agent_timeout') },
      }),
    );
    expect(html).toContain('>90%<');
    expect(html).toContain('data-slot="usage-refresh-error"');
    expect(html).toContain('Não deu para atualizar o uso. O agente demorou para responder. Tente de novo.');
    expect(html).toContain('Atualizado agora');
    expect(html).not.toContain('Retomar');
  });

  it('without a failed refresh there is no inline error', () => {
    const html = renderToStaticMarkup(
      createElement(UsageContent, { state, now: NOW, onRefresh: noop, onResume: noop, refreshFailed: null }),
    );
    expect(html).not.toContain('data-slot="usage-refresh-error"');
  });
});

describe('UsageAccountLine', () => {
  const render = (account: SessionAccountInfo): string => renderToStaticMarkup(createElement(UsageAccountLine, { account }));

  it('"Conta: <nome>" com o e-mail ao lado quando se sabe', () => {
    const html = render({ label: 'Trabalho', email: 'trabalho@exemplo.com' });
    expect(html).toContain('data-slot="usage-account"');
    expect(html).toContain('Conta: ');
    expect(html).toContain('Trabalho');
    expect(html).toContain('trabalho@exemplo.com');
  });

  it('sem e-mail conhecido mostra só o nome', () => {
    const html = render({ label: 'Casa', email: null });
    expect(html).toContain('Casa');
    expect(html).not.toContain(' · ');
  });

  it('o nome vai como texto, nunca como HTML', () => {
    const html = render({ label: '<i>x</i>', email: null });
    expect(html).not.toContain('<i>x</i>');
  });
});
