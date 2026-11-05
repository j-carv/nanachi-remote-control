import type { ResetRedeemResponse, ResetsResponse } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import {
  startRedeem,
  startResetsRequest,
  type RedeemState,
  type ResetsListState,
} from './resetsFlow.js';

interface Pending<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Lets the callbacks of settled promises run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeListClient() {
  const pending: Array<Pending<ResetsResponse>> = [];
  const client = {
    getUsageResets: (_sessionId: string) =>
      new Promise<ResetsResponse>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  };
  return { client, pending };
}

function fakeRedeemClient() {
  const pending: Array<Pending<ResetRedeemResponse>> = [];
  const calls: Array<{ sessionId: string; target: string }> = [];
  const client = {
    redeemUsageReset: (sessionId: string, target: string) => {
      calls.push({ sessionId, target });
      return new Promise<ResetRedeemResponse>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  };
  return { client, pending, calls };
}

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

describe('startResetsRequest', () => {
  it('reports loading first, then the rows and the agent message', async () => {
    const { client, pending } = fakeListClient();
    const states: ResetsListState[] = [];
    startResetsRequest(client, 's-1', (state) => states.push(state));
    expect(states).toEqual([{ status: 'loading' }]);

    pending[0]?.resolve(RESETS);
    await settle();
    expect(states.at(-1)).toEqual({ status: 'ready', entries: RESETS.entries, message: null });
  });

  it('keeps the message of a reply without rows', async () => {
    const { client, pending } = fakeListClient();
    const states: ResetsListState[] = [];
    startResetsRequest(client, 's-1', (state) => states.push(state));
    pending[0]?.resolve({ ...RESETS, entries: [], message: 'No provider accounts found. Use /login to add one.' });
    await settle();
    expect(states.at(-1)).toEqual({
      status: 'ready',
      entries: [],
      message: 'No provider accounts found. Use /login to add one.',
    });
  });

  it('reports an error with the error itself', async () => {
    const { client, pending } = fakeListClient();
    const states: ResetsListState[] = [];
    startResetsRequest(client, 's-1', (state) => states.push(state));
    const error = new ApiError('agent_timeout', 504, null, 'agent_timeout');
    pending[0]?.reject(error);
    await settle();
    expect(states.at(-1)).toEqual({ status: 'error', error });
  });

  it('drops a reply that arrives after cancel', async () => {
    const { client, pending } = fakeListClient();
    const states: ResetsListState[] = [];
    const cancel = startResetsRequest(client, 's-1', (state) => states.push(state));
    cancel();
    pending[0]?.resolve(RESETS);
    await settle();
    expect(states).toEqual([{ status: 'loading' }]);
  });

  it('drops an error that arrives after cancel', async () => {
    const { client, pending } = fakeListClient();
    const states: ResetsListState[] = [];
    const cancel = startResetsRequest(client, 's-1', (state) => states.push(state));
    cancel();
    pending[0]?.reject(new ApiError('network'));
    await settle();
    expect(states).toEqual([{ status: 'loading' }]);
  });
});

describe('startRedeem', () => {
  it('sends the redeem once with the target of the row, and reports running first', async () => {
    const { client, pending, calls } = fakeRedeemClient();
    const states: RedeemState[] = [];
    startRedeem(client, 's-1', 'anthropic/1', (state) => states.push(state), () => undefined);
    expect(states).toEqual([{ status: 'running', target: 'anthropic/1' }]);
    expect(calls).toEqual([{ sessionId: 's-1', target: 'anthropic/1' }]);
    pending[0]?.resolve({ outcome: 'reset', message: 'Reset applied.' });
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('a spent reset is done with the success tone and the agent line, then settles', async () => {
    const { client, pending } = fakeRedeemClient();
    const states: RedeemState[] = [];
    let settled = 0;
    startRedeem(client, 's-1', 'anthropic/1', (state) => states.push(state), () => (settled += 1));
    pending[0]?.resolve({ outcome: 'reset', message: 'Reset applied for fake@example.com (Anthropic).' });
    await settle();
    expect(states.at(-1)).toEqual({
      status: 'done',
      result: { tone: 'success', message: 'Reset applied for fake@example.com (Anthropic).' },
    });
    expect(settled).toBe(1);
  });

  it('an outcome that spent nothing is done with the neutral tone', async () => {
    const { client, pending } = fakeRedeemClient();
    const states: RedeemState[] = [];
    startRedeem(client, 's-1', 'anthropic/2', (state) => states.push(state), () => undefined);
    pending[0]?.resolve({ outcome: 'already_redeemed', message: 'that reset was already redeemed.' });
    await settle();
    expect(states.at(-1)).toEqual({
      status: 'done',
      result: { tone: 'neutral', message: 'that reset was already redeemed.' },
    });
  });

  it('a 504 is done as an error that cannot confirm the reset, settles, and is never sent again', async () => {
    const { client, pending, calls } = fakeRedeemClient();
    const states: RedeemState[] = [];
    let settled = 0;
    startRedeem(client, 's-1', 'anthropic/1', (state) => states.push(state), () => (settled += 1));
    pending[0]?.reject(new ApiError('agent_timeout', 504, null, 'agent_timeout'));
    await settle();
    expect(states.at(-1)).toEqual({
      status: 'done',
      result: {
        tone: 'error',
        message: 'Não deu para confirmar se o reset foi usado. Confira o uso antes de tentar de novo.',
      },
    });
    expect(settled).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('a 409 is done as an error with the in-progress text', async () => {
    const { client, pending } = fakeRedeemClient();
    const states: RedeemState[] = [];
    startRedeem(client, 's-1', 'anthropic/1', (state) => states.push(state), () => undefined);
    pending[0]?.reject(new ApiError('unexpected', 409, null, 'reset_in_progress'));
    await settle();
    expect(states.at(-1)).toEqual({
      status: 'done',
      result: { tone: 'error', message: 'Já tem um reset em andamento.' },
    });
  });

  it('after cancel the reply is dropped and nothing settles', async () => {
    const { client, pending } = fakeRedeemClient();
    const states: RedeemState[] = [];
    let settled = 0;
    const cancel = startRedeem(client, 's-1', 'anthropic/1', (state) => states.push(state), () => (settled += 1));
    cancel();
    pending[0]?.resolve({ outcome: 'reset', message: 'x' });
    await settle();
    expect(states).toEqual([{ status: 'running', target: 'anthropic/1' }]);
    expect(settled).toBe(0);
  });
});
