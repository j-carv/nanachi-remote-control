import {
  SessionConfigOptionSchema,
  type ConfigValue,
  type SessionConfigOption,
} from '@nanachi/shared';
import { z } from 'zod';
import { friendlyWorkModes, isDangerousModeId, type WorkModeKind } from './chat/workMode.js';
import { t } from './i18n/index.js';
import type { StorageLike } from './machines.js';

export const AGENT_CONFIG_PREFIX = 'nanachi.agentConfig.';

export function agentConfigKey(agentId: string): string {
  return `${AGENT_CONFIG_PREFIX}${agentId}`;
}

const StoredOptionsSchema = z.array(SessionConfigOptionSchema);

/**
 * Modes Nanachi offers per agent: the same list as the daemon's (packages/daemon/src/agent-modes.ts), so change both
 * together. An agent that is not listed offers every mode it announces.
 */
const OFFERED_MODES_BY_AGENT: ReadonlyMap<string, readonly string[]> = new Map([['omp', ['default']]]);

/**
 * Última configuração usada com o agente (opções com o valor escolhido em `currentValue`).
 * Lixo no storage ou storage bloqueado viram lista vazia, nunca exceção.
 * Um modo perigoso não volta: a sessão nova começa no modo padrão do agente.
 * A mode the agent no longer offers is not restored either (see withOfferedModes).
 */
export function readAgentConfig(storage: StorageLike, agentId: string): SessionConfigOption[] {
  let raw: string | null;
  try {
    raw = storage.getItem(agentConfigKey(agentId));
  } catch {
    return [];
  }
  if (raw === null) return [];

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const parsed = StoredOptionsSchema.safeParse(json);
  return parsed.success ? withoutDangerousModes(withOfferedModes(parsed.data, agentId), agentId) : [];
}

/**
 * A stored mode the agent no longer offers is dropped with its choices, and the choices it does not offer are removed
 * from the rest (omp's plan, saved before Nanachi stopped offering it). So a new session starts in the agent's default
 * mode, and no stored plan is sent when it is created.
 */
function withOfferedModes(options: readonly SessionConfigOption[], agentId: string): SessionConfigOption[] {
  const offered = OFFERED_MODES_BY_AGENT.get(agentId);
  if (offered === undefined) return [...options];
  return options.flatMap((option): SessionConfigOption[] => {
    if (!isModeSelect(option)) return [option];
    if (!offered.includes(option.currentValue)) return [];
    return [{ ...option, options: option.options.filter((choice) => offered.includes(choice.value)) }];
  });
}

/**
 * The chat keeps writing the config it is in, so a chat in bypass mode leaves it in storage. Restoring that for a new
 * session would start the session in bypass without asking, so the mode option is skipped instead: the agent then
 * starts in its own default mode.
 */
function withoutDangerousModes(options: readonly SessionConfigOption[], agentId: string): SessionConfigOption[] {
  return options.filter((option) => !(isModeSelect(option) && isDangerousModeId(option.currentValue, agentId)));
}

function isModeSelect(option: SessionConfigOption): option is SelectOption {
  return option.type === 'select' && option.category === 'mode';
}

/**
 * Whether setting `value` on `option` moves the session INTO a dangerous mode. Changing a mode that is already
 * dangerous asks nothing. The chat asks the user before it sends such a change. `agentId` picks the agent's own mode
 * meanings (see workMode.ts).
 */
export function isDangerousSwitch(option: SessionConfigOption, value: ConfigValue, agentId?: string): boolean {
  return (
    isModeSelect(option) &&
    typeof value === 'string' &&
    value !== option.currentValue &&
    isDangerousModeId(value, agentId)
  );
}

/** The session's mode select (category `mode`), with its agent-given options, or undefined when there is none. */
export function modeOptionOf(options: readonly SessionConfigOption[]): SelectOption | undefined {
  return options.find(isModeSelect);
}

/** Label of a work mode kind, in the current language. Read at each call, so a language switch shows. */
export function workModeLabel(kind: WorkModeKind): string {
  return t(`chat:agentConfig.workMode.${kind}`);
}

/** The mode select with its choices renamed (known ids) and ordered, as the Session settings drawer shows them. */
function workModeOption(option: SelectOption, agentId: string | undefined): SelectOption {
  return { ...option, options: friendlyWorkModes(option.options, workModeLabel, agentId) };
}

/** Retorna `false` se o storage recusou a escrita. */
export function writeAgentConfig(
  storage: StorageLike,
  agentId: string,
  options: readonly SessionConfigOption[],
): boolean {
  try {
    storage.setItem(agentConfigKey(agentId), JSON.stringify(options));
    return true;
  } catch {
    return false;
  }
}

/** Troca o valor escolhido de uma opção. Valor de tipo errado ou id desconhecido não muda nada. */
export function applyConfigValue(
  options: readonly SessionConfigOption[],
  configId: string,
  value: ConfigValue,
): SessionConfigOption[] {
  return options.map((option) => {
    if (option.id !== configId) return option;
    if (option.type === 'select' && typeof value === 'string') {
      return { ...option, currentValue: value };
    }
    if (option.type === 'boolean' && typeof value === 'boolean') {
      return { ...option, currentValue: value };
    }
    return option;
  });
}

/** Corpo `config` do POST /api/sessions: id -> valor escolhido. */
export function toCreateConfig(options: readonly SessionConfigOption[]): Record<string, ConfigValue> {
  return Object.fromEntries(
    options.map((option): [string, ConfigValue] => [option.id, option.currentValue]),
  );
}

/** Seletores fixos do topo do chat, na ordem em que aparecem. O rótulo vem de `chat:agentConfig.<categoria>`. */
export const PRIMARY_CATEGORIES = ['mode', 'model', 'thought_level'] as const;

export type SelectOption = Extract<SessionConfigOption, { type: 'select' }>;

export interface PrimaryControl {
  label: string;
  option: SelectOption;
}

/**
 * Separa as opções de topo (Acesso, Modelo, Effort, só selects) do resto,
 * que vai para o painel "Mais opções". `agentId` decides the names of the work modes (see workMode.ts).
 */
export function splitOptions(
  options: readonly SessionConfigOption[],
  agentId?: string,
): {
  primary: PrimaryControl[];
  extra: SessionConfigOption[];
} {
  const primary: PrimaryControl[] = [];
  for (const category of PRIMARY_CATEGORIES) {
    const found = options.find((option) => option.category === category && option.type === 'select');
    if (found?.type === 'select') {
      const option = category === 'mode' ? workModeOption(found, agentId) : found;
      primary.push({ label: t(`chat:agentConfig.${category}`), option });
    }
  }

  const primaryIds = new Set(primary.map((control) => control.option.id));
  const extra = options.filter((option) => !primaryIds.has(option.id));
  return { primary, extra };
}
