import { describe, expect, it } from 'vitest';
import {
  friendlyWorkModes,
  isDangerousModeId,
  orderWorkModes,
  workModeKindOf,
  workModeNameOf,
  type WorkModeKind,
} from './workMode.js';

const labelOf = (kind: WorkModeKind): string => `label:${kind}`;

describe('workModeKindOf', () => {
  it('maps the ids Claude Code (claude-agent-acp) announces', () => {
    expect(workModeKindOf('default')).toBe('ask');
    expect(workModeKindOf('acceptEdits')).toBe('acceptEdits');
    expect(workModeKindOf('plan')).toBe('plan');
    expect(workModeKindOf('auto')).toBe('auto');
    expect(workModeKindOf('bypassPermissions')).toBe('bypass');
  });

  it('maps the ids Codex (codex-acp) announces', () => {
    expect(workModeKindOf('read-only')).toBe('readOnly');
    expect(workModeKindOf('workspace-write')).toBe('acceptEdits');
    expect(workModeKindOf('agent')).toBe('auto');
    expect(workModeKindOf('agent-full-access')).toBe('bypass');
  });

  it('maps the ids of Antigravity (agy acp) and the names used in the request', () => {
    expect(workModeKindOf('accept-edits')).toBe('acceptEdits');
    expect(workModeKindOf('full-access')).toBe('bypass');
    expect(workModeKindOf('bypass')).toBe('bypass');
    expect(workModeKindOf('dontAsk')).toBe('dontAsk');
  });

  it('ignores case, spaces, dashes and underscores', () => {
    expect(workModeKindOf('ACCEPT_EDITS')).toBe('acceptEdits');
    expect(workModeKindOf('Read Only')).toBe('readOnly');
    expect(workModeKindOf(' Bypass-Permissions ')).toBe('bypass');
  });

  it('leaves an unknown id unmapped', () => {
    expect(workModeKindOf('custom-mode')).toBeUndefined();
    expect(workModeKindOf('')).toBeUndefined();
  });
});

describe('isDangerousModeId', () => {
  it('is true only for the modes that run tools without asking', () => {
    for (const id of ['bypassPermissions', 'bypass', 'agent-full-access', 'full-access']) {
      expect(isDangerousModeId(id), id).toBe(true);
    }
    for (const id of ['default', 'plan', 'acceptEdits', 'auto', 'read-only', 'agent', 'workspace-write', 'custom-mode']) {
      expect(isDangerousModeId(id), id).toBe(false);
    }
  });
});

describe('orderWorkModes', () => {
  it('puts the known modes from the most restrictive to the most permissive, then the unknown ones in the agent order', () => {
    const ordered = orderWorkModes([
      { value: 'bypassPermissions' },
      { value: 'zeta' },
      { value: 'plan' },
      { value: 'default' },
      { value: 'alpha' },
    ]);
    expect(ordered.map((option) => option.value)).toEqual(['default', 'plan', 'bypassPermissions', 'zeta', 'alpha']);
  });

  it('does not change the input list', () => {
    const input = [{ value: 'bypassPermissions' }, { value: 'default' }];
    orderWorkModes(input);
    expect(input.map((option) => option.value)).toEqual(['bypassPermissions', 'default']);
  });
});

describe('workModeNameOf', () => {
  it('names a known mode with the label of its kind', () => {
    expect(workModeNameOf({ value: 'acceptEdits', name: 'Accept edits' }, labelOf)).toBe('label:acceptEdits');
  });

  it('keeps the agent name of a mode it does not know', () => {
    expect(workModeNameOf({ value: 'custom-mode', name: 'Custom' }, labelOf)).toBe('Custom');
  });
});

describe('friendlyWorkModes', () => {
  it('renames the known modes, keeps their descriptions, and orders them', () => {
    const options = [
      { value: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' },
      { value: 'default', name: 'Manual', description: 'Always ask before making changes' },
      { value: 'custom-mode', name: 'Custom', description: null },
    ];
    expect(friendlyWorkModes(options, labelOf)).toEqual([
      { value: 'default', name: 'label:ask', description: 'Always ask before making changes' },
      { value: 'bypassPermissions', name: 'label:bypass', description: 'Accepts all permissions' },
      { value: 'custom-mode', name: 'Custom', description: null },
    ]);
  });

  it('does not change the input options', () => {
    const options = [{ value: 'default', name: 'Manual' }];
    friendlyWorkModes(options, labelOf);
    expect(options).toEqual([{ value: 'default', name: 'Manual' }]);
  });
});

const OMP_PLAN_DESCRIPTION = 'Read-only planning mode that drafts a plan to a markdown file before any code changes';

describe('omp (Oh My Pi) work modes', () => {
  // omp's approval policy is yolo: its `default` runs tools and edits without asking, so it is not `ask`.
  it('maps its default to auto and its plan to plan', () => {
    expect(workModeKindOf('default', 'omp')).toBe('auto');
    expect(workModeKindOf('plan', 'omp')).toBe('plan');
  });

  it('keeps its default out of the dangerous modes, and bypass in them', () => {
    expect(isDangerousModeId('default', 'omp')).toBe(false);
    expect(isDangerousModeId('plan', 'omp')).toBe(false);
    expect(isDangerousModeId('bypassPermissions', 'omp')).toBe(true);
  });

  it('orders Planning before Automatic mode', () => {
    const ordered = orderWorkModes([{ value: 'default' }, { value: 'plan' }], 'omp');
    expect(ordered.map((option) => option.value)).toEqual(['plan', 'default']);
  });

  it('names its modes with the kind labels and keeps the agent description', () => {
    const options = [
      { value: 'default', name: 'Standard ACP headless mode', description: null },
      { value: 'plan', name: 'Plan', description: OMP_PLAN_DESCRIPTION },
    ];
    expect(friendlyWorkModes(options, labelOf, 'omp')).toEqual([
      { value: 'plan', name: 'label:plan', description: OMP_PLAN_DESCRIPTION },
      { value: 'default', name: 'label:auto', description: null },
    ]);
  });
});

describe('work modes with an agent id for the other agents', () => {
  it('keeps the shared mapping for claude, codex and an unknown agent', () => {
    expect(workModeKindOf('default', 'claude')).toBe('ask');
    expect(workModeKindOf('default', 'some-agent')).toBe('ask');
    expect(workModeKindOf('agent', 'codex')).toBe('auto');
    expect(workModeKindOf('read-only', 'codex')).toBe('readOnly');
  });

  it('keeps the shared mapping for the ids omp does not override', () => {
    expect(workModeKindOf('acceptEdits', 'omp')).toBe('acceptEdits');
  });
});
