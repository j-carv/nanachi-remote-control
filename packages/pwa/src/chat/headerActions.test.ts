import type { Loop } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { planHeaderActions, type HeaderActionsInput, type HeaderRowAction, type SheetRow } from './headerActions.js';
import { loopChipView } from './loop.js';

const NOW = 1_700_000_000_000;

/** A loop in the given state. `lastError` is set only by a failure, as the daemon does. */
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

/** A plain phone chat with nothing going on: the baseline each test changes one field of. */
const CHAT: HeaderActionsInput = {
  kind: 'acp',
  layout: 'phone',
  loop: null,
  backgroundTotal: 0,
  backgroundActive: 0,
};

const entries = (rows: readonly SheetRow[]): string[] => rows.map((row) => row.entry);

describe('planHeaderActions: the header row', () => {
  it('keeps only Configurar and the menu on a phone chat', () => {
    expect(planHeaderActions(CHAT).row).toEqual(['configure', 'more']);
  });

  it('keeps the same row on the phone and on the two-pane layout', () => {
    expect(planHeaderActions({ ...CHAT, layout: 'phone' }).row).toEqual(['configure', 'more']);
    expect(planHeaderActions({ ...CHAT, layout: 'two-pane' }).row).toEqual(['configure', 'more']);
  });

  it('adds Arquivos and Terminal before Configurar only in the three-pane layout', () => {
    expect(planHeaderActions({ ...CHAT, layout: 'three-pane' }).row).toEqual<HeaderRowAction[]>([
      'files',
      'terminal',
      'configure',
      'more',
    ]);
  });

  it('never puts usage, changes or loop in the row, whatever the state', () => {
    const kinds = ['acp', 'pty'] as const;
    const layouts = ['phone', 'two-pane', 'three-pane'] as const;
    const loops = [null, loopIn('active'), loopIn('paused'), loopIn('paused', 'agente caiu'), loopIn('stopped')] as const;
    for (const kind of kinds) {
      for (const layout of layouts) {
        for (const loop of loops) {
          for (const backgroundActive of [0, 2]) {
            const { row } = planHeaderActions({ ...CHAT, kind, layout, loop, backgroundTotal: 2, backgroundActive });
            expect(row.slice(-2)).toEqual(['configure', 'more']);
            expect(row.every((action) => action === 'files' || action === 'terminal' || action === 'configure' || action === 'more')).toBe(true);
          }
        }
      }
    }
  });
});

describe('planHeaderActions: the menu', () => {
  it('lists usage, loop and changes for a chat, then the remove action last', () => {
    expect(planHeaderActions(CHAT).sheet).toEqual<SheetRow[]>([
      { entry: 'usage' },
      { entry: 'loop' },
      { entry: 'changes' },
      { entry: 'remove' },
    ]);
  });

  it('lists background work between loop and changes, once there are items', () => {
    const rows = planHeaderActions({ ...CHAT, backgroundTotal: 3, backgroundActive: 1 }).sheet;
    expect(entries(rows)).toEqual(['usage', 'loop', 'background', 'changes', 'remove']);
    expect(rows[2]).toEqual({ entry: 'background', active: 1, total: 3 });
  });

  it('leaves background work out of the menu when there are no items', () => {
    expect(entries(planHeaderActions(CHAT).sheet)).not.toContain('background');
  });

  it('has no usage and no loop for a terminal session, only changes and remove', () => {
    expect(entries(planHeaderActions({ ...CHAT, kind: 'pty', loop: loopIn('active') }).sheet)).toEqual(['changes', 'remove']);
  });

  it('gives the changes row no count: its detail is not part of the plan', () => {
    expect(planHeaderActions(CHAT).sheet).toContainEqual({ entry: 'changes' });
  });
});

describe('planHeaderActions: loop chip', () => {
  it('shows the chip while the loop is active', () => {
    const plan = planHeaderActions({ ...CHAT, loop: loopIn('active') });
    expect(plan.chips.loop).toBe(true);
    expect(plan.sheet).toContainEqual({ entry: 'loop' });
  });

  it('shows no chip for a loop the user paused, only its row in the menu', () => {
    const plan = planHeaderActions({ ...CHAT, loop: loopIn('paused') });
    expect(plan.chips.loop).toBe(false);
    expect(plan.sheet).toContainEqual({ entry: 'loop' });
  });

  it('keeps the chip for a loop paused after an error, in the error variant', () => {
    const loop = loopIn('paused', 'agente caiu');
    expect(planHeaderActions({ ...CHAT, loop }).chips.loop).toBe(true);
    expect(loopChipView(loop, NOW)?.phase).toBe('error');
  });

  it('shows no chip without a loop or with a stopped one, and the menu row stays to start one', () => {
    for (const loop of [null, loopIn('stopped'), loopIn('stopped', 'agente caiu')]) {
      const plan = planHeaderActions({ ...CHAT, loop });
      expect(plan.chips.loop).toBe(false);
      expect(plan.sheet).toContainEqual({ entry: 'loop' });
    }
  });

  it('shows no loop chip in a terminal session', () => {
    expect(planHeaderActions({ ...CHAT, kind: 'pty', loop: loopIn('active') }).chips.loop).toBe(false);
  });
});

describe('planHeaderActions: background work', () => {
  it('shows the chip only while items are active', () => {
    expect(planHeaderActions({ ...CHAT, backgroundTotal: 2, backgroundActive: 0 }).chips.background).toBe(false);
    expect(planHeaderActions({ ...CHAT, backgroundTotal: 2, backgroundActive: 1 }).chips.background).toBe(true);
  });

  it('never shows an empty chip', () => {
    const plan = planHeaderActions(CHAT);
    expect(plan.chips).toEqual({ loop: false, background: false });
  });
});
