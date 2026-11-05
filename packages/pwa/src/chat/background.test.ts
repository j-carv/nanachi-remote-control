import type { SessionEvent, SessionStatus } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import {
  backgroundChipCount,
  backgroundEntries,
  formatElapsed,
  groupEntries,
  isActiveStatus,
  jobStateOf,
  type BackgroundView,
} from './background.js';
import { applyEvents, createChatState, type ChatState } from './reducer.js';

type Body = DistributiveOmit<SessionEvent, 'seq' | 'sessionId' | 'ts'>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const BASE_TS = 1_700_000_000_000;

function ev(seq: number, body: Body): SessionEvent {
  return { seq, sessionId: 's-1', ts: BASE_TS + seq * 1000, ...body } as SessionEvent;
}

function stateOf(status: SessionStatus, events: SessionEvent[]): ChatState {
  return applyEvents(createChatState(status), events);
}

function viewOf(state: ChatState): BackgroundView {
  return { active: isActiveStatus(state.status), turnEnds: state.turnEnds };
}

function startBash(seq: number, toolCallId: string, label: string): SessionEvent {
  return ev(seq, {
    kind: 'tool_call',
    toolCallId,
    title: 'Bash',
    status: 'in_progress',
    background: { kind: 'shell', state: 'running', label },
    content: [],
    locations: [],
  });
}

const TURN_END: Body = { kind: 'turn_end', stopReason: 'end_turn' };

describe('isActiveStatus', () => {
  it('only a running turn or a pending permission keeps background work live', () => {
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('awaiting_permission')).toBe(true);
    expect(isActiveStatus('idle')).toBe(false);
    expect(isActiveStatus('starting')).toBe(false);
    expect(isActiveStatus('stopped')).toBe(false);
  });
});

describe('effective state of background items', () => {
  it('a running item stays running while its turn has not ended', () => {
    const state = stateOf('running', [startBash(1, 'bash', 'Testes')]);
    const [entry] = backgroundEntries(state.items, viewOf(state));
    expect(entry?.state).toBe('running');
  });

  it('a running item becomes unknown after a turn_end; finished items keep their state', () => {
    const state = stateOf('idle', [
      startBash(1, 'bash', 'Testes'),
      ev(2, {
        kind: 'tool_call',
        toolCallId: 'sub',
        title: 'Agent',
        background: { kind: 'subagent', state: 'completed', label: 'Pronto' },
        content: [],
        locations: [],
      }),
      ev(3, TURN_END),
    ]);
    const pairs = backgroundEntries(state.items, viewOf(state)).map((entry) => [entry.label, entry.state]);
    expect(pairs).toEqual([
      ['Pronto', 'completed'],
      ['Testes', 'unknown'],
    ]);
  });

  it('a running item is unknown when the session is not active, even without a turn_end', () => {
    const state = stateOf('idle', [startBash(1, 'bash', 'Servidor')]);
    const [entry] = backgroundEntries(state.items, viewOf(state));
    expect(entry?.state).toBe('unknown');
  });

  it('an update after the turn end that still says running brings the item back to running', () => {
    const state = stateOf('running', [
      startBash(1, 'bash', 'Testes'),
      ev(2, TURN_END),
      ev(3, { kind: 'tool_call_update', toolCallId: 'bash', title: 'Bash', status: 'in_progress' }),
    ]);
    const [entry] = backgroundEntries(state.items, viewOf(state));
    expect(entry?.state).toBe('running');
  });

  it('a stopped item is not changed by the turn end', () => {
    const state = stateOf('idle', [
      ev(1, {
        kind: 'tool_call',
        toolCallId: 'job',
        title: 'task',
        background: { kind: 'job', state: 'stopped' },
        content: [],
        locations: [],
      }),
      ev(2, TURN_END),
    ]);
    const [entry] = backgroundEntries(state.items, viewOf(state));
    expect(entry?.state).toBe('stopped');
  });
});

describe('backgroundEntries', () => {
  it('lists the background items newest first, with label, agent type, jobs and timing', () => {
    const state = stateOf('running', [
      ev(1, {
        kind: 'tool_call',
        toolCallId: 'sub',
        title: 'Agent',
        background: { kind: 'subagent', state: 'running', label: 'Revisar parser', agentType: 'Explore' },
        content: [],
        locations: [],
      }),
      ev(2, { kind: 'agent_message_chunk', text: 'texto no meio' }),
      startBash(3, 'bash', 'Testes'),
      ev(4, {
        kind: 'tool_call',
        toolCallId: 'task',
        title: 'Compilar e testar',
        background: {
          kind: 'job',
          state: 'running',
          jobs: [{ id: 'j1', label: 'Compilar', status: 'completed' }],
        },
        content: [],
        locations: [],
      }),
    ]);

    const entries = backgroundEntries(state.items, viewOf(state));
    expect(entries.map((entry) => [entry.kind, entry.label])).toEqual([
      ['job', 'Compilar e testar'],
      ['shell', 'Testes'],
      ['subagent', 'Revisar parser'],
    ]);
    expect(entries[2]).toMatchObject({ agentType: 'Explore', startedAt: BASE_TS + 1000, updatedAt: BASE_TS + 1000 });
    expect(entries[0]?.jobs).toEqual([{ id: 'j1', label: 'Compilar', status: 'completed' }]);
  });

  it('falls back to the tool title when the background has no label, and skips tool calls without background', () => {
    const state = stateOf('running', [
      ev(1, { kind: 'tool_call', toolCallId: 'plain', title: 'Ler', content: [], locations: [] }),
      ev(2, {
        kind: 'tool_call',
        toolCallId: 'job',
        title: 'Compilar',
        background: { kind: 'job', state: 'running' },
        content: [],
        locations: [],
      }),
    ]);
    expect(backgroundEntries(state.items, viewOf(state)).map((entry) => entry.label)).toEqual(['Compilar']);
  });
});

describe('backgroundChipCount', () => {
  it('counts running items and the unknown ones from the latest turn only', () => {
    // Turn 1 starts a shell command and ends while it is still going.
    const afterFirst = stateOf('idle', [startBash(1, 'a1', 'Turno 1'), ev(2, TURN_END)]);
    // Turn 2 is running and starts a subagent that is still going.
    const afterSecond = applyEvents(afterFirst, [
      ev(3, { kind: 'status', status: 'running' }),
      ev(4, {
        kind: 'tool_call',
        toolCallId: 'b1',
        title: 'Agent',
        background: { kind: 'subagent', state: 'running', label: 'Turno 2' },
        content: [],
        locations: [],
      }),
    ]);
    expect(backgroundChipCount(backgroundEntries(afterSecond.items, viewOf(afterSecond)), afterSecond.turnEnds)).toBe(2);

    // Turn 2 ends too: turn 1's leftover is now two turns old, so it only lives in the drawer.
    const afterThird = applyEvents(afterSecond, [ev(5, TURN_END)]);
    const entries = backgroundEntries(afterThird.items, viewOf(afterThird));
    expect(entries.map((entry) => [entry.label, entry.state])).toEqual([
      ['Turno 2', 'unknown'],
      ['Turno 1', 'unknown'],
    ]);
    expect(backgroundChipCount(entries, afterThird.turnEnds)).toBe(1);
  });
});

describe('groupEntries', () => {
  it('splits the entries into subagents, commands and jobs, keeping their order', () => {
    const state = stateOf('running', [
      startBash(1, 'bash', 'Testes'),
      ev(2, {
        kind: 'tool_call',
        toolCallId: 'sub',
        title: 'Agent',
        background: { kind: 'subagent', state: 'completed', label: 'Parser' },
        content: [],
        locations: [],
      }),
      ev(3, {
        kind: 'tool_call',
        toolCallId: 'job',
        title: 'task',
        background: { kind: 'job', state: 'running', label: 'Lote' },
        content: [],
        locations: [],
      }),
    ]);
    const groups = groupEntries(backgroundEntries(state.items, viewOf(state)));
    expect(groups.subagents.map((entry) => entry.label)).toEqual(['Parser']);
    expect(groups.commands.map((entry) => entry.label)).toEqual(['Testes']);
    expect(groups.jobs.map((entry) => entry.label)).toEqual(['Lote']);
  });
});

describe('jobStateOf', () => {
  it('reads the job status words of Codex and omp into one state', () => {
    expect(jobStateOf({ id: 'a', status: 'pendingInit' }, 'running')).toBe('running');
    expect(jobStateOf({ id: 'a', status: 'completed' }, 'running')).toBe('completed');
    expect(jobStateOf({ id: 'a', status: 'errored' }, 'running')).toBe('failed');
    expect(jobStateOf({ id: 'a', status: 'interrupted' }, 'running')).toBe('stopped');
    expect(jobStateOf({ id: 'a', status: 'mystery' }, 'running')).toBe('unknown');
  });

  it('a job that still says running is unknown once its parent is no longer running', () => {
    expect(jobStateOf({ id: 'a', status: 'running' }, 'unknown')).toBe('unknown');
    expect(jobStateOf({ id: 'a', status: 'running' }, 'completed')).toBe('unknown');
    expect(jobStateOf({ id: 'a', status: 'completed' }, 'unknown')).toBe('completed');
  });
});

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours in Portuguese', () => {
    expect(formatElapsed(0)).toBe('0 s');
    expect(formatElapsed(45_000)).toBe('45 s');
    expect(formatElapsed(125_000)).toBe('2 min');
    expect(formatElapsed(3_900_000)).toBe('1 h 5 min');
  });

  it('never goes below zero (clock skew between the phone and the PC)', () => {
    expect(formatElapsed(-5_000)).toBe('0 s');
  });
});
