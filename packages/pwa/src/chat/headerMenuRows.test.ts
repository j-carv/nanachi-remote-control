import type { Loop } from '@nanachi/shared';
import { Gauge, GitCommitVertical, Layers, Repeat } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '../i18n/index.js';
import { planHeaderActions, type HeaderActionsInput } from './headerActions.js';
import { headerMenuRows, type HeaderMenuActions } from './headerMenuRows.js';

const NOW = 1_700_000_000_000;

function loopIn(state: Loop['state'], lastError: string | null = null): Loop {
  return {
    sessionId: 's-1',
    prompt: 'revise os testes',
    mode: 'interval',
    intervalMs: 180_000,
    maxIterations: null,
    iterations: 1,
    state,
    nextRunAt: state === 'active' ? NOW + 180_000 : null,
    lastRunAt: NOW - 60_000,
    lastError,
    createdAt: NOW - 600_000,
    revision: 3,
  };
}

const CHAT: HeaderActionsInput = {
  kind: 'acp',
  layout: 'phone',
  loop: null,
  backgroundTotal: 0,
  backgroundActive: 0,
};

/** Builds the menu rows the way the screen does: the plan's sheet, then the mapping. */
function rowsFor(loop: Loop | null, input: Partial<HeaderActionsInput> = {}, actions = spies()) {
  const plan = planHeaderActions({ ...CHAT, ...input, loop });
  return headerMenuRows(plan.sheet, loop, actions);
}

function spies(): HeaderMenuActions {
  return {
    openUsage: vi.fn(),
    openLoop: vi.fn(),
    openBackground: vi.fn(),
    openHistory: vi.fn(),
    remove: vi.fn(),
  };
}

const labels = (rows: ReturnType<typeof headerMenuRows>) => rows.map((row) => row.label);
const details = (rows: ReturnType<typeof headerMenuRows>) => rows.map((row) => row.detail);

beforeEach(() => setLanguage('pt-BR'));
afterEach(() => setLanguage('pt-BR'));

describe('headerMenuRows: labels and order', () => {
  it('lists usage, loop, commit history and remove for a chat with no loop and no background work', () => {
    const rows = rowsFor(null);
    expect(labels(rows)).toEqual(['Uso do agente', 'Modo Loop', 'Histórico de commits', 'Remover do app']);
  });

  it('puts background work between the loop and the commit history, with its label', () => {
    const rows = rowsFor(null, { backgroundTotal: 3, backgroundActive: 0 });
    expect(labels(rows)).toEqual(['Uso do agente', 'Modo Loop', 'Segundo plano', 'Histórico de commits', 'Remover do app']);
  });

  it('leaves background work out when there are no items', () => {
    expect(labels(rowsFor(null))).not.toContain('Segundo plano');
  });

  it('shows only the commit history and remove for a terminal session', () => {
    expect(labels(rowsFor(loopIn('active'), { kind: 'pty' }))).toEqual(['Histórico de commits', 'Remover do app']);
  });

  it('marks the remove row as destructive and keeps it last', () => {
    const rows = rowsFor(null, { backgroundTotal: 1, backgroundActive: 1 });
    expect(rows.at(-1)?.tone).toBe('danger');
    expect(rows.slice(0, -1).every((row) => row.tone === undefined)).toBe(true);
  });
});

describe('headerMenuRows: loop detail', () => {
  it('has no detail without a loop', () => {
    expect(rowsFor(null)[1]?.detail).toBeUndefined();
  });

  it('says Ativo for an active loop', () => {
    expect(rowsFor(loopIn('active'))[1]?.detail).toBe('Ativo');
  });

  it('says Pausado for a loop the user paused', () => {
    expect(rowsFor(loopIn('paused'))[1]?.detail).toBe('Pausado');
  });

  it('says Pausado após um erro for a loop paused by an error', () => {
    expect(rowsFor(loopIn('paused', 'agente caiu'))[1]?.detail).toBe('Pausado após um erro');
  });

  it('has no detail for a stopped loop, though the row stays to start one', () => {
    const rows = rowsFor(loopIn('stopped'));
    expect(rows[1]?.label).toBe('Modo Loop');
    expect(rows[1]?.detail).toBeUndefined();
  });

  it('writes the loop detail in English when the language is English', () => {
    setLanguage('en');
    expect(rowsFor(loopIn('paused', 'agente caiu'))[1]?.detail).toBe('Paused after an error');
  });
});

describe('headerMenuRows: background detail', () => {
  it('counts the running items while some run', () => {
    const rows = rowsFor(null, { backgroundTotal: 3, backgroundActive: 1 });
    expect(details(rows)[2]).toBe('1 em andamento');
  });

  it('counts the total when nothing runs', () => {
    const rows = rowsFor(null, { backgroundTotal: 3, backgroundActive: 0 });
    expect(details(rows)[2]).toBe('3 no total');
  });
});

describe('headerMenuRows: commit history row', () => {
  it('has no detail, and keeps its icon and label', () => {
    const history = rowsFor(null)[2];
    expect(history?.label).toBe('Histórico de commits');
    expect(history?.detail).toBeUndefined();
    expect(history?.icon).toBe(GitCommitVertical);
  });
});

describe('headerMenuRows: icons', () => {
  it('gives each row its icon, and the remove row none', () => {
    const rows = rowsFor(loopIn('active'), { backgroundTotal: 1, backgroundActive: 0 });
    expect(rows.map((row) => row.icon)).toEqual([Gauge, Repeat, Layers, GitCommitVertical, undefined]);
  });
});

describe('headerMenuRows: what a row does', () => {
  it('routes each row to its own action', () => {
    const actions = spies();
    const rows = rowsFor(null, { backgroundTotal: 1, backgroundActive: 0 }, actions);
    for (const row of rows) row.onSelect();

    expect(actions.openUsage).toHaveBeenCalledTimes(1);
    expect(actions.openLoop).toHaveBeenCalledTimes(1);
    expect(actions.openBackground).toHaveBeenCalledTimes(1);
    expect(actions.openHistory).toHaveBeenCalledTimes(1);
    expect(actions.remove).toHaveBeenCalledTimes(1);
  });

  it('marks the rows that open a dialog, and not the one that opens a screen', () => {
    const rows = rowsFor(loopIn('active'), { backgroundTotal: 1, backgroundActive: 0 });
    expect(rows.map((row) => row.haspopup)).toEqual(['dialog', 'dialog', 'dialog', undefined, 'dialog']);
  });
});
