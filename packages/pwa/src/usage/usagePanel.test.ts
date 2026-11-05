import type { ResetRedeemResponse, ResetsResponse, UsageResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import {
  createUsagePanel,
  INITIAL_PANEL_STATE,
  type UsagePanel,
  type UsagePanelClient,
  type UsagePanelState,
} from './usagePanel.js';

interface Pending<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Lets the callbacks of settled promises run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const USAGE: UsageResponse = { agent: 'omp', text: '5 hours: 20% used', fetchedAt: 1_700_000_000_000 };
const RESETS: ResetsResponse = {
  agent: 'omp',
  entries: [
    {
      target: 'anthropic/1',
      accountLabel: 'fake@example.com',
      providerLabel: 'Anthropic',
      available: 2,
      usable: 1,
      expiresAt: null,
      note: null,
      active: true,
    },
  ],
  message: null,
  fetchedAt: 1_700_000_000_000,
};
const REDEEMED: ResetRedeemResponse = { outcome: 'reset', message: 'Reset applied for fake@example.com (Anthropic).' };

/** Fake client: every request stays pending until the test settles it, in call order. */
function fakeClient() {
  const usage: Array<Pending<UsageResponse>> = [];
  const lists: Array<Pending<ResetsResponse>> = [];
  const redeems: Array<Pending<ResetRedeemResponse> & { target: string }> = [];
  const client: UsagePanelClient = {
    fetchSessionUsage: () => new Promise((resolve, reject) => void usage.push({ resolve, reject })),
    getUsageResets: () => new Promise((resolve, reject) => void lists.push({ resolve, reject })),
    redeemUsageReset: (_sessionId, target) =>
      new Promise((resolve, reject) => void redeems.push({ resolve, reject, target })),
  };
  return { client, usage, lists, redeems };
}

function setup(withResets = true) {
  const fake = fakeClient();
  const states: UsagePanelState[] = [];
  const panel: UsagePanel = createUsagePanel(fake.client, 's-1', withResets, (state) => states.push(state));
  const last = (): UsagePanelState => states.at(-1) ?? INITIAL_PANEL_STATE;
  return { ...fake, panel, states, last };
}

/** Opens the panel and answers usage and list, so it is on screen with its rows. */
async function openLoaded(env: ReturnType<typeof setup>): Promise<void> {
  env.panel.open();
  env.usage[0]?.resolve(USAGE);
  await settle();
  env.lists[0]?.resolve(RESETS);
  await settle();
}

describe('createUsagePanel: open', () => {
  it('starts with the usage loading and nothing else', () => {
    const { last } = setup();
    expect(last()).toEqual(INITIAL_PANEL_STATE);
  });

  it('open reads the usage, then the resets list for agents that have it', async () => {
    const env = setup();
    env.panel.open();
    expect(env.last().usage).toEqual({ status: 'loading' });
    expect(env.last().list).toEqual({ status: 'idle' });
    expect(env.lists).toHaveLength(0);

    env.usage[0]?.resolve(USAGE);
    await settle();
    expect(env.last().usage).toMatchObject({ status: 'ready', text: USAGE.text });
    expect(env.last().list).toEqual({ status: 'loading' });

    env.lists[0]?.resolve(RESETS);
    await settle();
    expect(env.last().list).toEqual({ status: 'ready', entries: RESETS.entries, message: null });
  });

  it('an agent without resets never asks for the list', async () => {
    const env = setup(false);
    await openLoaded(env);
    expect(env.lists).toHaveLength(0);
    expect(env.last().list).toEqual({ status: 'idle' });
  });

  it('a usage error shows the error and leaves the list idle', async () => {
    const env = setup();
    const error = new ApiError('unexpected', 409, null, 'session_not_active');
    env.panel.open();
    env.usage[0]?.reject(error);
    await settle();
    expect(env.last().usage).toEqual({ status: 'error', error });
    expect(env.last().list).toEqual({ status: 'idle' });
    expect(env.lists).toHaveLength(0);
  });

  it('closing drops the pending replies; reopening starts a new request', async () => {
    const env = setup();
    env.panel.open();
    env.panel.close();
    env.usage[0]?.resolve(USAGE);
    await settle();
    expect(env.last().usage).toEqual({ status: 'loading' });

    env.panel.open();
    expect(env.usage).toHaveLength(2);
    env.usage[1]?.resolve({ ...USAGE, text: 'nova' });
    await settle();
    expect(env.last().usage).toMatchObject({ status: 'ready', text: 'nova' });
  });

  it('refresh starts a new request and drops the reply of the one it replaced', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.refresh();
    expect(env.last().usage).toEqual({ status: 'loading' });
    expect(env.last().list).toEqual({ status: 'idle' });
    env.panel.refresh();
    env.usage[2]?.resolve({ ...USAGE, text: 'nova' });
    env.usage[1]?.resolve({ ...USAGE, text: 'antiga' });
    await settle();
    expect(env.last().usage).toMatchObject({ status: 'ready', text: 'nova' });
  });

  it('refresh while closed does nothing', () => {
    const env = setup();
    env.panel.refresh();
    expect(env.usage).toHaveLength(0);
  });
});

describe('createUsagePanel: redeem', () => {
  it('sends exactly one request, shows running, then the reply, and reads usage and list again quietly', async () => {
    const env = setup();
    await openLoaded(env);

    env.panel.redeem('anthropic/1');
    env.panel.redeem('anthropic/1');
    expect(env.redeems).toHaveLength(1);
    expect(env.redeems[0]?.target).toBe('anthropic/1');
    expect(env.last().redeem).toEqual({ status: 'running', target: 'anthropic/1' });

    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    expect(env.last().redeem).toMatchObject({ status: 'done', result: { tone: 'success' } });
    // The stale rows are hidden and the loaded usage stays on screen (no skeleton).
    expect(env.last().list).toEqual({ status: 'loading' });
    expect(env.last().usage).toMatchObject({ status: 'ready', text: USAGE.text });
    expect(env.usage).toHaveLength(2);

    env.usage[1]?.resolve({ ...USAGE, text: 'depois' });
    await settle();
    env.lists[1]?.resolve(RESETS);
    await settle();
    expect(env.last().usage).toMatchObject({ status: 'ready', text: 'depois' });
    expect(env.last().list).toMatchObject({ status: 'ready' });
    expect(env.last().redeem).toMatchObject({ status: 'done' });
    expect(env.redeems).toHaveLength(1);
  });

  it('a second redeem is refused while the first one runs, and allowed after it settled', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.panel.redeem('anthropic/2');
    expect(env.redeems).toHaveLength(1);

    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    env.panel.redeem('anthropic/2');
    expect(env.redeems).toHaveLength(2);
    expect(env.last().redeem).toEqual({ status: 'running', target: 'anthropic/2' });
  });

  it('refresh is ignored while a redeem runs', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.panel.refresh();
    expect(env.usage).toHaveLength(1);
  });

  it('a failed request is shown as the error tone and still reads everything again, without a second POST', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.redeems[0]?.reject(new ApiError('agent_timeout', 504, null, 'agent_timeout'));
    await settle();
    expect(env.last().redeem).toMatchObject({
      status: 'done',
      result: {
        tone: 'error',
        message: 'Não deu para confirmar se o reset foi usado. Confira o uso antes de tentar de novo.',
      },
    });
    expect(env.usage).toHaveLength(2);
    expect(env.redeems).toHaveLength(1);
  });

  it('a 502 is also reported as unconfirmed', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.redeems[0]?.reject(new ApiError('agent_failed', 502, null, 'agent_failed'));
    await settle();
    expect(env.last().redeem).toMatchObject({
      status: 'done',
      result: { tone: 'error', message: expect.stringContaining('Não deu para confirmar') },
    });
  });
});

describe('createUsagePanel: the quiet refresh after a redeem fails', () => {
  it('keeps the last ready usage, shows the error, keeps the reply, and the list leaves loading', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    expect(env.last().list).toEqual({ status: 'loading' });

    const error = new ApiError('agent_timeout', 504, null, 'agent_timeout');
    env.usage[1]?.reject(error);
    await settle();
    expect(env.last().usage).toMatchObject({ status: 'ready', text: USAGE.text });
    expect(env.last().refreshFailed).toEqual({ error });
    expect(env.last().redeem).toMatchObject({ status: 'done', result: { tone: 'success' } });
    // The list is asked for anyway: it must not stay on "loading".
    expect(env.lists).toHaveLength(2);
    expect(env.last().list).toEqual({ status: 'loading' });

    env.lists[1]?.resolve({ ...RESETS, entries: [] , message: 'Nenhum reset salvo nesta conta' });
    await settle();
    expect(env.last().list).toEqual({ status: 'ready', entries: [], message: 'Nenhum reset salvo nesta conta' });
  });

  it('a failing list also leaves loading (as an error)', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    env.usage[1]?.reject(new ApiError('network'));
    await settle();
    const error = new ApiError('network');
    env.lists[1]?.reject(error);
    await settle();
    expect(env.last().list).toEqual({ status: 'error', error });
    expect(env.last().usage).toMatchObject({ status: 'ready' });
  });

  it('the error goes away when a later read works', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    env.usage[1]?.reject(new ApiError('network'));
    await settle();
    expect(env.last().refreshFailed).not.toBeNull();

    env.panel.refresh();
    expect(env.last().refreshFailed).toBeNull();
    env.usage[2]?.resolve({ ...USAGE, text: 'de novo' });
    await settle();
    expect(env.last().usage).toMatchObject({ status: 'ready', text: 'de novo' });
    expect(env.last().refreshFailed).toBeNull();
  });

  it('an agent without resets keeps the usage and shows the error too', async () => {
    const env = setup(false);
    await openLoaded(env);
    env.panel.redeem('x');
    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    env.usage[1]?.reject(new ApiError('network'));
    await settle();
    expect(env.last().usage).toMatchObject({ status: 'ready' });
    expect(env.last().refreshFailed).not.toBeNull();
    expect(env.lists).toHaveLength(0);
  });
});

describe('createUsagePanel: a redeem that ends while the drawer is closed', () => {
  it('keeps the reply, does not read anything while closed, and the next open shows it', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.panel.close();

    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    expect(env.last().redeem).toMatchObject({ status: 'done', result: { tone: 'success' } });
    expect(env.usage).toHaveLength(1);
    expect(env.lists).toHaveLength(1);

    env.panel.open();
    expect(env.last().redeem).toMatchObject({ status: 'done', result: { tone: 'success' } });
    expect(env.last().usage).toEqual({ status: 'loading' });
    expect(env.usage).toHaveLength(2);

    env.usage[1]?.resolve(USAGE);
    await settle();
    env.lists[1]?.resolve(RESETS);
    await settle();
    expect(env.last().redeem).toMatchObject({ status: 'done' });
    expect(env.last().list).toMatchObject({ status: 'ready' });
  });

  it('a failed redeem that ends while closed keeps its error reply too', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.panel.close();
    env.redeems[0]?.reject(new ApiError('network'));
    await settle();
    env.panel.open();
    expect(env.last().redeem).toMatchObject({ status: 'done', result: { tone: 'error' } });
  });

  it('closing and reopening while it still runs keeps it running, and a second redeem is still refused', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.panel.close();
    env.panel.open();
    expect(env.last().redeem).toEqual({ status: 'running', target: 'anthropic/1' });
    env.panel.redeem('anthropic/1');
    expect(env.redeems).toHaveLength(1);

    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    expect(env.last().redeem).toMatchObject({ status: 'done' });
  });

  it('a manual refresh does not clear the reply', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    env.usage[1]?.resolve(USAGE);
    await settle();
    env.lists[1]?.resolve(RESETS);
    await settle();

    env.panel.refresh();
    expect(env.last().redeem).toMatchObject({ status: 'done' });
  });
});

describe('createUsagePanel: dismiss and new redeem', () => {
  async function withReply() {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    env.usage[1]?.resolve(USAGE);
    await settle();
    env.lists[1]?.resolve(RESETS);
    await settle();
    return env;
  }

  it('dismissing clears a finished reply', async () => {
    const env = await withReply();
    env.panel.dismissRedeem();
    expect(env.last().redeem).toEqual({ status: 'idle' });
  });

  it('dismissing does nothing while a redeem runs or when there is no reply', async () => {
    const env = await withReply();
    env.panel.dismissRedeem();
    const before = env.states.length;
    env.panel.dismissRedeem();
    expect(env.states).toHaveLength(before);

    env.panel.redeem('anthropic/1');
    env.panel.dismissRedeem();
    expect(env.last().redeem).toEqual({ status: 'running', target: 'anthropic/1' });
  });

  it('a new redeem replaces the old reply with the running state', async () => {
    const env = await withReply();
    env.panel.redeem('anthropic/1');
    expect(env.last().redeem).toEqual({ status: 'running', target: 'anthropic/1' });
    expect(env.redeems).toHaveLength(2);
  });
});

describe('createUsagePanel: dispose', () => {
  it('reports nothing after dispose, even for a redeem that was already sent', async () => {
    const env = setup();
    await openLoaded(env);
    env.panel.redeem('anthropic/1');
    env.panel.dispose();
    const seen = env.states.length;

    env.redeems[0]?.resolve(REDEEMED);
    await settle();
    expect(env.states).toHaveLength(seen);
    expect(env.usage).toHaveLength(1);
  });

  it('open after dispose does nothing', () => {
    const env = setup();
    env.panel.dispose();
    env.panel.open();
    expect(env.usage).toHaveLength(0);
  });
});
