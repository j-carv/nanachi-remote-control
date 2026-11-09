import type { SessionConfigOption } from '@nanachi/shared';
import { describe, expect, it } from 'vitest';
import { isModeAllowed, offeredConfigOptions } from '../src/agent-modes.js';

/** The mode select an agent announces: its `default` and its `plan`, with `currentValue` as given. */
function modeOption(currentValue: string): SessionConfigOption {
  return {
    id: 'mode',
    name: 'Mode',
    description: null,
    category: 'mode',
    type: 'select',
    currentValue,
    options: [
      { value: 'default', name: 'Default', description: null },
      { value: 'plan', name: 'Plan', description: null },
    ],
  };
}

const MODEL: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  description: null,
  category: 'model',
  type: 'select',
  currentValue: 'fast',
  options: [{ value: 'fast', name: 'Fast' }],
};

/** A select in another category that happens to offer a `plan` value: the mode rule must not touch it. */
const EFFORT_WITH_PLAN: SessionConfigOption = {
  id: 'effort',
  name: 'Effort',
  description: null,
  category: 'thought_level',
  type: 'select',
  currentValue: 'plan',
  options: [
    { value: 'plan', name: 'Plan' },
    { value: 'high', name: 'High' },
  ],
};

const BOOLEAN: SessionConfigOption = {
  id: 'ultra',
  name: 'Ultra',
  description: null,
  category: 'model_config',
  type: 'boolean',
  currentValue: false,
};

describe('isModeAllowed', () => {
  it('omp offers its default and not its plan, nor a mode it never announces', () => {
    expect(isModeAllowed('omp', 'default')).toBe(true);
    expect(isModeAllowed('omp', 'plan')).toBe(false);
    expect(isModeAllowed('omp', 'bypassPermissions')).toBe(false);
  });

  it.each(['claude', 'codex', 'agy', 'some-agent', 'constructor'])('%s offers every mode', (agentId) => {
    expect(isModeAllowed(agentId, 'plan')).toBe(true);
    expect(isModeAllowed(agentId, 'default')).toBe(true);
  });
});

describe('offeredConfigOptions for omp', () => {
  it('on its default, drops the plan choice and keeps the other options as they are', () => {
    expect(offeredConfigOptions('omp', [modeOption('default'), MODEL, BOOLEAN])).toEqual([
      { ...modeOption('default'), options: [{ value: 'default', name: 'Default', description: null }] },
      MODEL,
      BOOLEAN,
    ]);
  });

  it('on plan, keeps plan as the current mode so the session shows what it really is', () => {
    expect(offeredConfigOptions('omp', [modeOption('plan')])).toEqual([modeOption('plan')]);
  });

  it('keeps the plan value of a select that is not the mode category', () => {
    expect(offeredConfigOptions('omp', [EFFORT_WITH_PLAN])).toEqual([EFFORT_WITH_PLAN]);
  });

  it('does not change the options it was given', () => {
    const announced = [modeOption('default')];
    offeredConfigOptions('omp', announced);
    expect(announced).toEqual([modeOption('default')]);
  });
});

describe('offeredConfigOptions for the other agents', () => {
  it.each(['claude', 'codex', 'agy', 'some-agent'])('%s gets its options unchanged, plan included', (agentId) => {
    const announced = [modeOption('default'), MODEL, EFFORT_WITH_PLAN, BOOLEAN];
    expect(offeredConfigOptions(agentId, announced)).toEqual(announced);
  });
});
