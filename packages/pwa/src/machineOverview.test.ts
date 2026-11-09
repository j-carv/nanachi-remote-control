import type { AgentAccount, HealthResponse, Session, Workspace } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { setLanguage } from './i18n/index.js';
import type { Machine } from './machines.js';
import {
  countSessions,
  lastActivity,
  loadMachineOverview,
  loggedInAgents,
  featuredSessions,
  sessionGroup,
  summarize,
  summaryLabels,
  type MachineOverview,
  type OverviewClient,
} from './machineOverview.js';

const MACHINE: Machine = { id: 'm1', name: 'OFFICE-PC', baseUrl: 'http://100.64.0.1:7777', token: 'tok' };

function session(overrides: Partial<Session> & Pick<Session, 'id' | 'status' | 'updatedAt'>): Session {
  return {
    workspaceId: 'w1',
    agent: 'omp',
    kind: 'acp',
    title: `Sessão ${overrides.id}`,
    accountId: null,
    worktree: null,
    createdAt: 1,
    ...overrides,
  };
}

function account(label: string, status: AgentAccount['status']): AgentAccount {
  return { agentId: label.toLowerCase(), label, status, account: null, detail: null, checkedAt: 1, supportsAccounts: false, profiles: [] };
}

const workspace = (id: string): Workspace => ({ id, name: id, path: `C:\\Projects\\${id}`, createdAt: 1, muted: false });

describe('sessionGroup', () => {
  it('groups starting and running as running, awaiting permission and idle as their own groups', () => {
    expect(sessionGroup('starting')).toBe('running');
    expect(sessionGroup('running')).toBe('running');
    expect(sessionGroup('awaiting_permission')).toBe('awaiting');
    expect(sessionGroup('idle')).toBe('idle');
  });

  it('leaves stopped and error sessions out of the counts', () => {
    expect(sessionGroup('stopped')).toBeNull();
    expect(sessionGroup('error')).toBeNull();
  });
});

describe('countSessions', () => {
  it('counts each group and ignores stopped and error sessions', () => {
    const sessions = [
      session({ id: 'a', status: 'running', updatedAt: 1 }),
      session({ id: 'b', status: 'starting', updatedAt: 1 }),
      session({ id: 'c', status: 'awaiting_permission', updatedAt: 1 }),
      session({ id: 'd', status: 'idle', updatedAt: 1 }),
      session({ id: 'e', status: 'idle', updatedAt: 1 }),
      session({ id: 'f', status: 'stopped', updatedAt: 1 }),
      session({ id: 'g', status: 'error', updatedAt: 1 }),
    ];
    expect(countSessions(sessions)).toEqual({ running: 2, awaiting: 1, idle: 2 });
  });

  it('is all zero for no sessions', () => {
    expect(countSessions([])).toEqual({ running: 0, awaiting: 0, idle: 0 });
  });
});

describe('featuredSessions', () => {
  it('puts sessions that need the user first, then running ones, then the rest by recency, capped at the limit', () => {
    const sessions = [
      session({ id: 'idle-old', status: 'idle', updatedAt: 10 }),
      session({ id: 'idle-new', status: 'idle', updatedAt: 40 }),
      session({ id: 'running', status: 'running', updatedAt: 20 }),
      session({ id: 'awaiting', status: 'awaiting_permission', updatedAt: 5 }),
      session({ id: 'stopped', status: 'stopped', updatedAt: 50 }),
    ];
    expect(featuredSessions(sessions, 3).map((item) => item.id)).toEqual(['awaiting', 'running', 'idle-new']);
  });

  it('defaults to three and does not mutate the input', () => {
    const sessions = [1, 2, 3, 4].map((n) => session({ id: `s${n}`, status: 'idle', updatedAt: n }));
    const before = sessions.map((item) => item.id);
    expect(featuredSessions(sessions)).toHaveLength(3);
    expect(sessions.map((item) => item.id)).toEqual(before);
  });
});

describe('lastActivity', () => {
  it('is the newest updatedAt, or null without sessions', () => {
    expect(lastActivity([])).toBeNull();
    expect(
      lastActivity([session({ id: 'a', status: 'idle', updatedAt: 5 }), session({ id: 'b', status: 'idle', updatedAt: 9 })]),
    ).toBe(9);
  });
});

describe('loggedInAgents', () => {
  it('keeps only the labels of agents that are logged in, in the daemon order', () => {
    const accounts = [
      account('Omp', 'logged_in'),
      account('Claude', 'logged_out'),
      account('Codex', 'unknown'),
      account('Gemini', 'logged_in'),
    ];
    expect(loggedInAgents(accounts)).toEqual(['Omp', 'Gemini']);
  });
});

describe('summarize', () => {
  const ready = (sessions: Session[]): MachineOverview => ({
    status: 'ready',
    details: { latencyMs: 12, workspaceCount: 1, sessions, agents: [] },
  });

  it('sums running and awaiting sessions over ready machines only', () => {
    const summary = summarize([
      { machineId: 'a', overview: ready([session({ id: '1', status: 'running', updatedAt: 1 })]) },
      { machineId: 'b', overview: ready([session({ id: '2', status: 'awaiting_permission', updatedAt: 1 })]) },
      { machineId: 'c', overview: { status: 'offline' } },
      { machineId: 'd', overview: undefined },
    ]);
    expect(summary.running).toBe(1);
    expect(summary.awaiting).toBe(1);
  });

  it('targets the most recently updated awaiting session across machines', () => {
    const summary = summarize([
      {
        machineId: 'a',
        overview: ready([session({ id: 'old', workspaceId: 'wa', status: 'awaiting_permission', updatedAt: 5 })]),
      },
      {
        machineId: 'b',
        overview: ready([session({ id: 'new', workspaceId: 'wb', status: 'awaiting_permission', updatedAt: 9 })]),
      },
    ]);
    expect(summary.awaitingTarget).toEqual({ machineId: 'b', workspaceId: 'wb', sessionId: 'new' });
  });

  it('has no target when nothing awaits permission', () => {
    expect(summarize([{ machineId: 'a', overview: ready([]) }]).awaitingTarget).toBeNull();
  });
});

describe('summaryLabels', () => {
  it('writes the counts that are not zero, in Portuguese', () => {
    expect(summaryLabels({ running: 2, awaiting: 1, awaitingTarget: null })).toEqual({
      running: '2 rodando',
      awaiting: '1 aguardando você',
    });
  });

  it('returns null for a zero count', () => {
    expect(summaryLabels({ running: 0, awaiting: 3, awaitingTarget: null })).toEqual({
      running: null,
      awaiting: '3 aguardando você',
    });
    expect(summaryLabels({ running: 0, awaiting: 0, awaitingTarget: null })).toEqual({ running: null, awaiting: null });
  });

  it('writes the counts in English', () => {
    setLanguage('en');
    expect(summaryLabels({ running: 2, awaiting: 1, awaitingTarget: null })).toEqual({
      running: '2 running',
      awaiting: '1 waiting for you',
    });
  });
});

describe('loadMachineOverview', () => {
  const health: HealthResponse = { ok: true, machineId: 'm1', machineName: 'OFFICE-PC', version: '1.0.0' };

  /** Relógio que avança 30 ms por chamada: a primeira leitura é o início e a segunda fecha a medida. */
  function clock(): () => number {
    let t = 1000;
    return () => {
      t += 30;
      return t;
    };
  }

  function client(overrides: Partial<OverviewClient> = {}): OverviewClient {
    return {
      listWorkspaces: async () => [workspace('w1'), workspace('w2')],
      listSessions: async (id) =>
        id === 'w1'
          ? [session({ id: 'a', workspaceId: 'w1', status: 'running', updatedAt: 3 })]
          : [session({ id: 'b', workspaceId: 'w2', status: 'idle', updatedAt: 7 })],
      agentAccounts: async () => [account('Omp', 'logged_in')],
      ...overrides,
    };
  }

  it('reports offline after one failed health request, without asking for anything else', async () => {
    let calls = 0;
    const result = await loadMachineOverview(MACHINE, {
      fetchHealth: async () => {
        calls += 1;
        throw new Error('ECONNREFUSED');
      },
      client: () => {
        throw new Error('must not be called when offline');
      },
      now: clock(),
    });
    expect(result).toEqual({ status: 'offline' });
    expect(calls).toBe(1);
  });

  it('measures the latency of the health request', async () => {
    const result = await loadMachineOverview(MACHINE, {
      fetchHealth: async () => health,
      client: () => client(),
      now: clock(),
    });
    expect(result).toMatchObject({ status: 'ready', details: { latencyMs: 30 } });
  });

  it('collects workspaces, sessions from every workspace, and logged-in agents', async () => {
    const result = await loadMachineOverview(MACHINE, {
      fetchHealth: async () => health,
      client: () => client(),
      now: clock(),
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.details.workspaceCount).toBe(2);
    expect(result.details.sessions.map((item) => item.id).sort()).toEqual(['a', 'b']);
    expect(result.details.agents).toEqual(['Omp']);
  });

  it('keeps automation runs out of home rows, activity, counts and summary targets', async () => {
    const ordinary = session({ id: 'ordinary', status: 'running', updatedAt: 3 });
    const result = await loadMachineOverview(MACHINE, {
      fetchHealth: async () => health,
      client: () => client({
        listSessions: async (id) => id === 'w1'
          ? [
              ordinary,
              session({ id: 'scheduled-running', status: 'running', updatedAt: 100, automationRunId: 'run-1' }),
            ]
          : [
              session({
                id: 'scheduled-waiting', workspaceId: 'w2', status: 'awaiting_permission', updatedAt: 101,
                automationRunId: 'run-2',
              }),
            ],
      }),
      now: clock(),
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected a ready overview');
    expect(result.details.workspaceCount).toBe(2);
    expect(result.details.sessions).toEqual([ordinary]);
    expect(featuredSessions(result.details.sessions)).toEqual([ordinary]);
    expect(countSessions(result.details.sessions)).toEqual({ running: 1, awaiting: 0, idle: 0 });
    expect(lastActivity(result.details.sessions)).toBe(3);
    expect(summarize([{ machineId: MACHINE.id, overview: result }])).toEqual({
      running: 1, awaiting: 0, awaitingTarget: null,
    });
  });

  it('keeps the card when the agent accounts fail, with no agent chips', async () => {
    const result = await loadMachineOverview(MACHINE, {
      fetchHealth: async () => health,
      client: () => client({ agentAccounts: async () => Promise.reject(new Error('boom')) }),
      now: clock(),
    });
    expect(result).toMatchObject({ status: 'ready', details: { agents: [] } });
  });

  it('reports an error with the latency when the session lists fail on a reachable machine', async () => {
    const result = await loadMachineOverview(MACHINE, {
      fetchHealth: async () => health,
      client: () => client({ listWorkspaces: async () => Promise.reject(new Error('401')) }),
      now: clock(),
    });
    expect(result).toEqual({ status: 'error', latencyMs: 30 });
  });
});
