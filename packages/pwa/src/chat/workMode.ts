/**
 * Work modes: the agent's permission mode (the ACP option of category `mode`), named the way a person reads it.
 * Ids are the ones the adapters announce, as checked in their source:
 * - Claude Code (claude-agent-acp 0.100.0): default, acceptEdits, plan, auto, bypassPermissions (bypass only when
 *   the adapter allows it on this machine).
 * - Codex (codex-acp 2.5.0): read-only, workspace-write, agent, agent-full-access.
 * - Antigravity (agy acp): default, accept-edits, plan.
 * - Oh My Pi (omp): default, plan. Its `default` is per-agent, see KIND_OVERRIDES_BY_AGENT.
 * Ids that are not listed here keep the name the agent gave them.
 */

export type WorkModeKind = 'readOnly' | 'ask' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypass';

/** Order of the known kinds: from the most restrictive to the most permissive, and the dangerous one last. */
const KIND_ORDER: readonly WorkModeKind[] = ['readOnly', 'ask', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypass'];

/** Ids with their separators and case removed (`accept-edits`, `acceptEdits`, `ACCEPT_EDITS` are the same key). */
const KIND_BY_KEY: ReadonlyMap<string, WorkModeKind> = new Map<string, WorkModeKind>([
  ['readonly', 'readOnly'],
  ['default', 'ask'],
  ['acceptedits', 'acceptEdits'],
  // Codex "Workspace access": edits inside the workspace without asking.
  ['workspacewrite', 'acceptEdits'],
  ['plan', 'plan'],
  ['auto', 'auto'],
  // Codex "Auto review": the agent asks only about actions it judges unsafe.
  ['agent', 'auto'],
  ['dontask', 'dontAsk'],
  ['bypasspermissions', 'bypass'],
  ['bypass', 'bypass'],
  ['fullaccess', 'bypass'],
  // Codex "Full access".
  ['agentfullaccess', 'bypass'],
]);

/**
 * Per-agent exceptions to KIND_BY_KEY, keyed by agent id. Oh My Pi (omp) has an approval policy of `yolo`, so its
 * `default` runs tools and edits without asking. Under the shared table that id would read "Ask before edits", the
 * opposite of what happens, so omp's `default` is `auto`. Ids not listed here, and agents not listed here, keep the
 * shared table.
 */
const KIND_OVERRIDES_BY_AGENT: ReadonlyMap<string, ReadonlyMap<string, WorkModeKind>> = new Map([
  [
    'omp',
    new Map<string, WorkModeKind>([
      ['default', 'auto'],
      ['plan', 'plan'],
    ]),
  ],
]);

function keyOf(id: string): string {
  return id.toLowerCase().replace(/[^a-z]/g, '');
}

/** The kind of a mode key for one agent: the agent's own override first, then the shared table. */
function kindOfKey(key: string, agentId: string | undefined): WorkModeKind | undefined {
  const override = agentId === undefined ? undefined : KIND_OVERRIDES_BY_AGENT.get(agentId)?.get(key);
  return override ?? KIND_BY_KEY.get(key);
}

/** The kind of a mode id for an agent, or undefined for an id this module does not know. */
export function workModeKindOf(id: string, agentId?: string): WorkModeKind | undefined {
  return kindOfKey(keyOf(id), agentId);
}

/** Modes that run tools and change files without asking. Switching into one needs the user's confirmation. */
export function isDangerousModeId(id: string, agentId?: string): boolean {
  return workModeKindOf(id, agentId) === 'bypass';
}

function rankOf(id: string, agentId: string | undefined): number {
  const kind = workModeKindOf(id, agentId);
  return kind === undefined ? KIND_ORDER.length : KIND_ORDER.indexOf(kind);
}

/** The options in work mode order. Known modes come first; unknown ones keep the agent's order after them. */
export function orderWorkModes<T extends { value: string }>(options: readonly T[], agentId?: string): T[] {
  return [...options].sort((left, right) => rankOf(left.value, agentId) - rankOf(right.value, agentId));
}

/** The name to show for one mode: the label of its kind when the id is known, else the agent's name. */
export function workModeNameOf(
  option: { value: string; name: string },
  labelOf: (kind: WorkModeKind) => string,
  agentId?: string,
): string {
  const kind = workModeKindOf(option.value, agentId);
  return kind === undefined ? option.name : labelOf(kind);
}

/** Mode choices with the friendly names, in work mode order. The input is not changed. */
export function friendlyWorkModes<T extends { value: string; name: string }>(
  options: readonly T[],
  labelOf: (kind: WorkModeKind) => string,
  agentId?: string,
): T[] {
  return orderWorkModes(options, agentId).map((option) => ({
    ...option,
    name: workModeNameOf(option, labelOf, agentId),
  }));
}
