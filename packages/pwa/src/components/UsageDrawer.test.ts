import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { parseUsage } from '../usage/parseUsage.js';
import { startUsageRequest, type UsageState, UsageContent, updatedLabel } from './UsageDrawer.js';

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
