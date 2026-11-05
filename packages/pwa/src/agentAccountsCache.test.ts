import type { AgentAccount } from '@nanachi/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from './api.js';
import {
  ACCOUNTS_CACHE_MS,
  invalidateAgentAccounts,
  knownAccountSupport,
  loadAccountsForSession,
  loadAgentAccounts,
  resetAgentAccountsCache,
  type AccountsClient,
} from './agentAccountsCache.js';

const T0 = 1_700_000_000_000;

function profile(id: string): AgentAccount['profiles'][number] {
  return { id, label: id, isDefault: id === 'default', active: id === 'default', status: 'logged_in', account: null, detail: null, checkedAt: T0 };
}

function account(agentId: string, supportsAccounts: boolean, profileIds: string[] = []): AgentAccount {
  return {
    agentId,
    label: agentId,
    status: 'logged_in',
    account: null,
    detail: null,
    checkedAt: T0,
    supportsAccounts,
    profiles: profileIds.map(profile),
  };
}

const LIST: AgentAccount[] = [account('claude', true), account('omp', false)];

interface Pending {
  refresh: boolean;
  resolve(value: AgentAccount[]): void;
  reject(error: unknown): void;
}

/** A client whose requests stay pending until the test settles them. */
function fakeClient(baseUrl = 'http://pc-a:7777') {
  const requests: Pending[] = [];
  const client: AccountsClient = {
    baseUrl,
    agentAccounts: (refresh) => new Promise((resolve, reject) => void requests.push({ refresh, resolve, reject })),
  };
  return { client, requests };
}

/** A client that answers at once, with `list`. */
function instantClient(list: AgentAccount[] = LIST, baseUrl = 'http://pc-a:7777') {
  const calls: boolean[] = [];
  const client: AccountsClient = {
    baseUrl,
    agentAccounts: async (refresh) => {
      calls.push(refresh);
      return list;
    },
  };
  return { client, calls };
}

beforeEach(() => resetAgentAccountsCache());

describe('loadAgentAccounts', () => {
  it('asks the daemon once and reuses the answer while it is fresh', async () => {
    const { client, calls } = instantClient();
    expect(await loadAgentAccounts(client, { now: T0 })).toEqual(LIST);
    expect(await loadAgentAccounts(client, { now: T0 + ACCOUNTS_CACHE_MS - 1 })).toEqual(LIST);
    expect(calls).toEqual([false]);
  });

  it('keeps the answer for 2 minutes, then asks again', async () => {
    expect(ACCOUNTS_CACHE_MS).toBe(120_000);
    const { client, calls } = instantClient();
    await loadAgentAccounts(client, { now: T0 });
    await loadAgentAccounts(client, { now: T0 + ACCOUNTS_CACHE_MS });
    expect(calls).toEqual([false, false]);
  });

  it('two callers that ask together share one request', async () => {
    const { client, requests } = fakeClient();
    const first = loadAgentAccounts(client, { now: T0 });
    const second = loadAgentAccounts(client, { now: T0 });
    expect(requests).toHaveLength(1);
    requests[0]?.resolve(LIST);
    expect(await first).toEqual(LIST);
    expect(await second).toEqual(LIST);
  });

  it('is one cache per machine', async () => {
    const a = instantClient([account('claude', true)], 'http://pc-a:7777');
    const b = instantClient([account('codex', true)], 'http://pc-b:7777');
    expect(await loadAgentAccounts(a.client, { now: T0 })).toEqual([account('claude', true)]);
    expect(await loadAgentAccounts(b.client, { now: T0 })).toEqual([account('codex', true)]);
    expect(a.calls).toEqual([false]);
    expect(b.calls).toEqual([false]);
  });

  it('two clients of the same machine share the answer (new session sheet, chat, Settings)', async () => {
    const first = instantClient();
    const second = instantClient();
    await loadAgentAccounts(first.client, { now: T0 });
    await loadAgentAccounts(second.client, { now: T0 + 1000 });
    expect(second.calls).toEqual([]);
  });

  it('refresh asks the daemon to re-check (refresh=1) even when fresh, and stores the new answer', async () => {
    const { client, calls } = instantClient();
    await loadAgentAccounts(client, { now: T0 });
    const fresher = [account('claude', true)];
    const refreshing: AccountsClient = { baseUrl: client.baseUrl, agentAccounts: async (refresh) => (calls.push(refresh), fresher) };
    expect(await loadAgentAccounts(refreshing, { refresh: true, now: T0 + 1000 })).toEqual(fresher);
    expect(calls).toEqual([false, true]);
    expect(await loadAgentAccounts(client, { now: T0 + 2000 })).toEqual(fresher);
  });

  it('a failed request is not stored: the next call asks again', async () => {
    const { client, requests } = fakeClient();
    const failed = loadAgentAccounts(client, { now: T0 });
    const error = new ApiError('network');
    requests[0]?.reject(error);
    await expect(failed).rejects.toBe(error);

    const retry = loadAgentAccounts(client, { now: T0 + 1 });
    expect(requests).toHaveLength(2);
    requests[1]?.resolve(LIST);
    expect(await retry).toEqual(LIST);
  });
});

describe('invalidateAgentAccounts', () => {
  it('the next call asks the daemon again', async () => {
    const { client, calls } = instantClient();
    await loadAgentAccounts(client, { now: T0 });
    invalidateAgentAccounts(client.baseUrl);
    await loadAgentAccounts(client, { now: T0 + 1 });
    expect(calls).toEqual([false, false]);
  });

  it('only the machine it names', async () => {
    const a = instantClient([], 'http://pc-a:7777');
    const b = instantClient([], 'http://pc-b:7777');
    await loadAgentAccounts(a.client, { now: T0 });
    await loadAgentAccounts(b.client, { now: T0 });
    invalidateAgentAccounts('http://pc-a:7777');
    await loadAgentAccounts(a.client, { now: T0 + 1 });
    await loadAgentAccounts(b.client, { now: T0 + 1 });
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(1);
  });

  it('without an argument it clears every machine', async () => {
    const a = instantClient([], 'http://pc-a:7777');
    const b = instantClient([], 'http://pc-b:7777');
    await loadAgentAccounts(a.client, { now: T0 });
    await loadAgentAccounts(b.client, { now: T0 });
    invalidateAgentAccounts();
    await loadAgentAccounts(a.client, { now: T0 + 1 });
    await loadAgentAccounts(b.client, { now: T0 + 1 });
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(2);
  });

  it('an answer that was asked for before the invalidation is not stored, and is not joined later', async () => {
    const { client, requests } = fakeClient();
    const before = loadAgentAccounts(client, { now: T0 });
    invalidateAgentAccounts(client.baseUrl);

    const after = loadAgentAccounts(client, { now: T0 + 1 });
    expect(requests).toHaveLength(2);

    // The old answer arrives last: it must not replace the newer one.
    const newer = [account('claude', true)];
    requests[1]?.resolve(newer);
    requests[0]?.resolve([account('stale', false)]);
    expect(await after).toEqual(newer);
    expect(await before).toEqual([account('stale', false)]);
    expect(await loadAgentAccounts(client, { now: T0 + 2 })).toEqual(newer);
    expect(requests).toHaveLength(2);
  });

  it('an old answer that arrives with nothing newer stored does not fill the cache', async () => {
    const { client, requests } = fakeClient();
    const before = loadAgentAccounts(client, { now: T0 });
    invalidateAgentAccounts(client.baseUrl);
    requests[0]?.resolve(LIST);
    await before;

    const next = loadAgentAccounts(client, { now: T0 + 1 });
    expect(requests).toHaveLength(2);
    requests[1]?.resolve(LIST);
    await next;
  });

  it('naming a machine that was never asked is harmless', () => {
    expect(() => invalidateAgentAccounts('http://nobody:1')).not.toThrow();
  });
});

describe('knownAccountSupport', () => {
  it('is null until an answer says, then true or false per agent', async () => {
    const { client } = instantClient();
    expect(knownAccountSupport(client.baseUrl, 'claude')).toBeNull();
    await loadAgentAccounts(client, { now: T0 });
    expect(knownAccountSupport(client.baseUrl, 'claude')).toBe(true);
    expect(knownAccountSupport(client.baseUrl, 'omp')).toBe(false);
    expect(knownAccountSupport(client.baseUrl, 'other')).toBeNull();
    expect(knownAccountSupport('http://pc-b:7777', 'claude')).toBeNull();
  });

  it('survives an invalidation and the expiry of the answer', async () => {
    const { client } = instantClient();
    await loadAgentAccounts(client, { now: T0 });
    invalidateAgentAccounts(client.baseUrl);
    expect(knownAccountSupport(client.baseUrl, 'omp')).toBe(false);
  });
});

describe('loadAccountsForSession', () => {
  it('a terminal session never asks', async () => {
    const { client, calls } = instantClient();
    expect(await loadAccountsForSession(client, { kind: 'pty', agent: 'shell' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('an agent that is not known yet asks once, and the next chats reuse the answer', async () => {
    const { client, calls } = instantClient();
    expect(await loadAccountsForSession(client, { kind: 'acp', agent: 'claude' })).toEqual(LIST);
    expect(await loadAccountsForSession(client, { kind: 'acp', agent: 'claude' })).toEqual(LIST);
    expect(calls).toEqual([false]);
  });

  it('an agent that an earlier answer said has no accounts does not ask, even after the answer expired', async () => {
    const { client, calls } = instantClient();
    await loadAgentAccounts(client, { now: T0 });
    invalidateAgentAccounts(client.baseUrl);
    expect(calls).toHaveLength(1);

    expect(await loadAccountsForSession(client, { kind: 'acp', agent: 'omp' })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('an agent that has accounts asks again after an invalidation', async () => {
    const { client, calls } = instantClient();
    await loadAgentAccounts(client, { now: T0 });
    invalidateAgentAccounts(client.baseUrl);
    expect(await loadAccountsForSession(client, { kind: 'acp', agent: 'claude' })).toEqual(LIST);
    expect(calls).toHaveLength(2);
  });
});

describe('loadAccountsForSession: a session on an account the stored list does not have', () => {
  /** Answers the list in order: the first one is the stored (old) list. */
  function evolvingClient(lists: AgentAccount[][]) {
    const calls: boolean[] = [];
    const client: AccountsClient = {
      baseUrl: 'http://pc-a:7777',
      agentAccounts: async (refresh) => {
        calls.push(refresh);
        return lists[Math.min(calls.length - 1, lists.length - 1)] ?? [];
      },
    };
    return { client, calls };
  }

  const OLD = [account('claude', true, ['default'])];
  const NEW = [account('claude', true, ['default', 'a-1'])];

  it('reads the list once more and returns the new one', async () => {
    const { client, calls } = evolvingClient([OLD, NEW]);
    await loadAgentAccounts(client, { now: Date.now() });
    expect(await loadAccountsForSession(client, { kind: 'acp', agent: 'claude', accountId: 'a-1' })).toEqual(NEW);
    expect(calls).toEqual([false, false]);
    // And the new answer is the stored one.
    expect(await loadAccountsForSession(client, { kind: 'acp', agent: 'claude', accountId: 'a-1' })).toEqual(NEW);
    expect(calls).toHaveLength(2);
  });

  it('asks only once more when the account is still missing (it was removed)', async () => {
    const { client, calls } = evolvingClient([OLD, OLD]);
    expect(await loadAccountsForSession(client, { kind: 'acp', agent: 'claude', accountId: 'gone' })).toEqual(OLD);
    expect(calls).toHaveLength(2);
  });

  it('the principal, no account and an account the list has never read the list again', async () => {
    const { client, calls } = evolvingClient([NEW]);
    await loadAccountsForSession(client, { kind: 'acp', agent: 'claude', accountId: null });
    await loadAccountsForSession(client, { kind: 'acp', agent: 'claude', accountId: 'default' });
    await loadAccountsForSession(client, { kind: 'acp', agent: 'claude', accountId: 'a-1' });
    await loadAccountsForSession(client, { kind: 'acp', agent: 'claude' });
    expect(calls).toHaveLength(1);
  });

  it('an agent without accounts never triggers the second read', async () => {
    const { client, calls } = evolvingClient([[account('claude', true, ['default']), account('omp', false)]]);
    await loadAccountsForSession(client, { kind: 'acp', agent: 'claude', accountId: null });
    expect(await loadAccountsForSession(client, { kind: 'acp', agent: 'omp', accountId: 'a-1' })).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
