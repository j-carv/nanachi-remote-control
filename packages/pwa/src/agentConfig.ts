import {
  SessionConfigOptionSchema,
  type ConfigValue,
  type SessionConfigOption,
} from '@nanachi/shared';
import { z } from 'zod';
import { t } from './i18n/index.js';
import type { StorageLike } from './machines.js';

export const AGENT_CONFIG_PREFIX = 'nanachi.agentConfig.';

export function agentConfigKey(agentId: string): string {
  return `${AGENT_CONFIG_PREFIX}${agentId}`;
}

const StoredOptionsSchema = z.array(SessionConfigOptionSchema);

/**
 * Última configuração usada com o agente (opções com o valor escolhido em `currentValue`).
 * Lixo no storage ou storage bloqueado viram lista vazia, nunca exceção.
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
  return parsed.success ? parsed.data : [];
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
 * que vai para o painel "Mais opções".
 */
export function splitOptions(options: readonly SessionConfigOption[]): {
  primary: PrimaryControl[];
  extra: SessionConfigOption[];
} {
  const primary: PrimaryControl[] = [];
  for (const category of PRIMARY_CATEGORIES) {
    const found = options.find((option) => option.category === category && option.type === 'select');
    if (found?.type === 'select') primary.push({ label: t(`chat:agentConfig.${category}`), option: found });
  }

  const primaryIds = new Set(primary.map((control) => control.option.id));
  const extra = options.filter((option) => !primaryIds.has(option.id));
  return { primary, extra };
}
