import type { AgentAccount } from '@nanachi/shared';
import type { ApiClient } from './api.js';

/**
 * How long a `GET /api/agents/accounts` answer is reused. The daemon checks each login (a process per agent), so the
 * sheets that need the list (new session, session configuration, usage account line, Settings) share one answer per
 * machine instead of asking again each time they open.
 */
export const ACCOUNTS_CACHE_MS = 2 * 60_000;

/** The part of the API client the cache uses. `baseUrl` is the key: one cache per machine. */
export type AccountsClient = Pick<ApiClient, 'baseUrl' | 'agentAccounts'>;

interface MachineCache {
  accounts: AgentAccount[] | null;
  at: number;
  /** The request in flight, so two sheets opening together ask once. */
  pending: Promise<AgentAccount[]> | null;
  /**
   * Counts the requests and the invalidations. Only the answer of the latest request is stored, so an answer that was
   * asked for before an invalidation (or before a newer request) never overwrites a newer state.
   */
  seq: number;
  /** Whether each agent can have accounts. It never expires: it only changes when the daemon's config does. */
  support: Map<string, boolean>;
}

const machines = new Map<string, MachineCache>();

function cacheOf(baseUrl: string): MachineCache {
  let cache = machines.get(baseUrl);
  if (cache === undefined) {
    cache = { accounts: null, at: 0, pending: null, seq: 0, support: new Map() };
    machines.set(baseUrl, cache);
  }
  return cache;
}

export interface LoadAccountsOptions {
  /** Ignore the stored answer and the daemon's own cache (`?refresh=1`), then store the new answer. */
  refresh?: boolean;
  /** Current time in ms. Tests only. */
  now?: number;
}

/**
 * The accounts of every agent of the machine: from the cache while it is younger than `ACCOUNTS_CACHE_MS`, joining a
 * request that is already in flight, otherwise from the daemon. A failed request is not stored.
 */
export function loadAgentAccounts(client: AccountsClient, options: LoadAccountsOptions = {}): Promise<AgentAccount[]> {
  const { refresh = false, now = Date.now() } = options;
  const cache = cacheOf(client.baseUrl);
  if (!refresh) {
    if (cache.accounts !== null && now - cache.at < ACCOUNTS_CACHE_MS) return Promise.resolve(cache.accounts);
    if (cache.pending !== null) return cache.pending;
  }

  const id = ++cache.seq;
  const request: Promise<AgentAccount[]> = client.agentAccounts(refresh).then(
    (accounts) => {
      for (const account of accounts) cache.support.set(account.agentId, account.supportsAccounts);
      if (cache.seq === id) {
        cache.accounts = accounts;
        cache.at = now;
      }
      if (cache.pending === request) cache.pending = null;
      return accounts;
    },
    (error: unknown) => {
      if (cache.pending === request) cache.pending = null;
      throw error;
    },
  );
  cache.pending = request;
  return request;
}

/**
 * Drops the stored answer of a machine (all machines when `baseUrl` is omitted). Called after every account change:
 * create, rename, remove, "usar em novas sessões" and a login that worked. A request still in flight is not joined
 * afterwards, and its answer is not stored.
 */
export function invalidateAgentAccounts(baseUrl?: string): void {
  const targets = baseUrl === undefined ? [...machines.values()] : [machines.get(baseUrl)];
  for (const cache of targets) {
    if (cache === undefined) continue;
    cache.accounts = null;
    cache.pending = null;
    cache.seq += 1;
  }
}

/**
 * Whether the agent can have accounts, when an earlier answer of this machine said so: true, false, or null when it is
 * not known yet. Lets a screen skip the request for an agent that has none (omp, agy, a shell).
 */
export function knownAccountSupport(baseUrl: string, agentId: string): boolean | null {
  return machines.get(baseUrl)?.support.get(agentId) ?? null;
}

/** The agent has accounts, but none with this id: the stored list is older than the account. */
function lacksAccount(accounts: readonly AgentAccount[], agentId: string, accountId: string): boolean {
  const entry = accounts.find((account) => account.agentId === agentId);
  if (entry === undefined || !entry.supportsAccounts || entry.profiles.length === 0) return false;
  return !entry.profiles.some((profile) => profile.id === accountId);
}

/**
 * The accounts a chat needs for its agent, or null without asking the daemon when nothing is to be learned: not an
 * agent session (a terminal), or an agent that an earlier answer said has no accounts. When the session runs on an
 * account that the stored list does not have (created on another device in the last minutes), the list is read once
 * more instead of showing that session as if it were on the principal account.
 */
export async function loadAccountsForSession(
  client: AccountsClient,
  session: { kind: string; agent: string; accountId?: string | null },
): Promise<AgentAccount[] | null> {
  if (session.kind !== 'acp') return null;
  if (knownAccountSupport(client.baseUrl, session.agent) === false) return null;
  const accounts = await loadAgentAccounts(client);
  if (session.accountId != null && lacksAccount(accounts, session.agent, session.accountId)) {
    invalidateAgentAccounts(client.baseUrl);
    return loadAgentAccounts(client);
  }
  return accounts;
}

/** Forgets everything. Tests only. */
export function resetAgentAccountsCache(): void {
  machines.clear();
}
