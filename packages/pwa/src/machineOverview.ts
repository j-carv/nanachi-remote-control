import type { AgentAccount, HealthResponse, Session, SessionStatus, Workspace } from '@nanachi/shared';
import { t } from './i18n/index.js';
import type { SessionTarget } from './push/notificationRoute.js';
import type { Machine } from './machines.js';

/** Sessions are shown in three groups. Stopped and error sessions are listed but not counted. */
export type SessionGroup = 'running' | 'awaiting' | 'idle';

export interface SessionCounts {
  running: number;
  awaiting: number;
  idle: number;
}

export interface MachineDetails {
  latencyMs: number;
  workspaceCount: number;
  /** Ordinary sessions only; scheduled agent executions have their own workspace history. */
  sessions: readonly Session[];
  /** Labels of the agents that are logged in on the machine. */
  agents: readonly string[];
}

/**
 * What the home screen knows about one machine, from plain HTTP requests (not the WebSocket).
 * `offline`: the health request failed, so nothing else was requested.
 * `error`: the machine answered but its workspace or session lists did not load.
 */
export type MachineOverview =
  | { status: 'offline' }
  | { status: 'error'; latencyMs: number }
  | { status: 'ready'; details: MachineDetails };

export function sessionGroup(status: SessionStatus): SessionGroup | null {
  switch (status) {
    case 'starting':
    case 'running':
      return 'running';
    case 'awaiting_permission':
      return 'awaiting';
    case 'idle':
      return 'idle';
    case 'stopped':
    case 'error':
      return null;
  }
}

export function sessionAttentionRank(status: SessionStatus): number {
  if (status === 'awaiting_permission') return 0;
  if (status === 'error') return 1;
  return 2;
}

export function compareSessionAttention(a: Session, b: Session): number {
  return sessionAttentionRank(a.status) - sessionAttentionRank(b.status) || b.updatedAt - a.updatedAt;
}

export function countSessions(sessions: readonly Session[]): SessionCounts {
  const counts: SessionCounts = { running: 0, awaiting: 0, idle: 0 };
  for (const item of sessions) {
    const group = sessionGroup(item.status);
    if (group !== null) counts[group] += 1;
  }
  return counts;
}

const FEATURE_RANK: Record<SessionGroup, number> = { awaiting: 0, running: 1, idle: 2 };

/**
 * The sessions a card lists: the ones that need the user first, then running ones, then the rest by recency.
 * Stopped and error sessions come last. Does not change the input.
 */
export function featuredSessions(sessions: readonly Session[], limit = 3): Session[] {
  const rank = (item: Session): number => {
    const group = sessionGroup(item.status);
    return group === null ? 3 : FEATURE_RANK[group];
  };
  return [...sessions]
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function lastActivity(sessions: readonly Session[]): number | null {
  if (sessions.length === 0) return null;
  return Math.max(...sessions.map((item) => item.updatedAt));
}

export function loggedInAgents(accounts: readonly AgentAccount[]): string[] {
  return accounts.filter((account) => account.status === 'logged_in').map((account) => account.label);
}

export interface OverviewSummary {
  running: number;
  awaiting: number;
  /** The awaiting session that was updated last, across every ready machine. */
  awaitingTarget: SessionTarget | null;
}

export interface OverviewEntry {
  machineId: string;
  overview: MachineOverview | undefined;
}

/** Totals over the machines that answered. Offline, loading and failed machines add nothing. */
export function summarize(entries: readonly OverviewEntry[]): OverviewSummary {
  let running = 0;
  let awaiting = 0;
  let target: { session: Session; machineId: string } | null = null;

  for (const { machineId, overview } of entries) {
    if (overview?.status !== 'ready') continue;
    for (const item of overview.details.sessions) {
      const group = sessionGroup(item.status);
      if (group === 'running') running += 1;
      if (group !== 'awaiting') continue;
      awaiting += 1;
      if (target === null || item.updatedAt > target.session.updatedAt) target = { session: item, machineId };
    }
  }

  const awaitingTarget =
    target === null
      ? null
      : { machineId: target.machineId, workspaceId: target.session.workspaceId, sessionId: target.session.id };
  return { running, awaiting, awaitingTarget };
}

/** Summary line pieces in the current language. A zero count is `null`, so the screen can leave it out. */
export function summaryLabels(summary: OverviewSummary): { running: string | null; awaiting: string | null } {
  return {
    running: summary.running > 0 ? t('machines:summary.running', { count: summary.running }) : null,
    awaiting: summary.awaiting > 0 ? t('machines:summary.awaiting', { count: summary.awaiting }) : null,
  };
}

/** Requests one machine needs. Each method is one daemon route, reached with the machine's token. */
export interface OverviewClient {
  listWorkspaces(): Promise<readonly Workspace[]>;
  listSessions(workspaceId: string): Promise<readonly Session[]>;
  agentAccounts(refresh: boolean): Promise<readonly AgentAccount[]>;
}

export interface OverviewDeps {
  fetchHealth(baseUrl: string): Promise<HealthResponse>;
  client(machine: Machine): OverviewClient;
  /** Monotonic clock in milliseconds. */
  now(): number;
}

/**
 * Loads one machine's overview. The health request goes first: if it fails, the machine is offline and
 * no other request is sent. The agent accounts are optional, so a failure there only drops the chips.
 */
export async function loadMachineOverview(machine: Machine, deps: OverviewDeps): Promise<MachineOverview> {
  const started = deps.now();
  try {
    await deps.fetchHealth(machine.baseUrl);
  } catch {
    return { status: 'offline' };
  }
  const latencyMs = Math.round(deps.now() - started);

  try {
    const client = deps.client(machine);
    const [workspaces, accounts] = await Promise.all([
      client.listWorkspaces(),
      client.agentAccounts(false).catch((): readonly AgentAccount[] => []),
    ]);
    const perWorkspace = await Promise.all(workspaces.map((workspace) => client.listSessions(workspace.id)));
    return {
      status: 'ready',
      details: {
        latencyMs,
        workspaceCount: workspaces.length,
        sessions: perWorkspace.flat().filter((session) => session.automationRunId === undefined),
        agents: loggedInAgents(accounts),
      },
    };
  } catch {
    return { status: 'error', latencyMs };
  }
}
