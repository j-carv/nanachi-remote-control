import type { SessionConfigOption } from '@nanachi/shared';

/**
 * Work modes Nanachi offers, per agent id (the session's `agent`). An agent that is not listed offers every mode it
 * announces. Oh My Pi (`omp`) announces `default` and `plan`, but Nanachi offers only `default`: Nanachi declares no
 * elicitation capability, so omp approves its own plan and starts implementing, which is not what asking for a plan
 * means. The PWA keeps its own copy of this list (packages/pwa/src/agentConfig.ts): change both together.
 */
const OFFERED_MODES_BY_AGENT: ReadonlyMap<string, readonly string[]> = new Map([['omp', ['default']]]);

/** Whether Nanachi offers `modeId` for `agentId`. An agent without a list offers every mode. */
export function isModeAllowed(agentId: string, modeId: string): boolean {
  const offered = OFFERED_MODES_BY_AGENT.get(agentId);
  return offered === undefined || offered.includes(modeId);
}

type ModeSelect = Extract<SessionConfigOption, { type: 'select' }>;

function isModeSelect(option: SessionConfigOption): option is ModeSelect {
  return option.type === 'select' && option.category === 'mode';
}

/**
 * The options Nanachi shows for `agentId`. For an agent with a list, the mode select drops the modes the list leaves
 * out, except its current one: a session that really is in plan keeps showing plan, and the person can switch to an
 * offered mode from there. Every other option, and every option of an agent without a list, comes back as it was.
 * The input is not changed.
 */
export function offeredConfigOptions(agentId: string, options: readonly SessionConfigOption[]): SessionConfigOption[] {
  if (!OFFERED_MODES_BY_AGENT.has(agentId)) return [...options];
  return options.map((option) => {
    if (!isModeSelect(option)) return option;
    const choices = option.options.filter(
      (choice) => choice.value === option.currentValue || isModeAllowed(agentId, choice.value),
    );
    return { ...option, options: choices };
  });
}
