import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema, DEFAULT_AGENTS, type Config } from '@nanachi/shared';

/** Config com machineName sempre preenchido (default: hostname). */
export type LoadedConfig = Config & { machineName: string };

/** Agentes default que o arquivo não define entram em memória; os do arquivo vencem no mesmo id. */
function withDefaultAgents(config: Config): Config {
  return { ...config, agents: { ...DEFAULT_AGENTS, ...config.agents } };
}

/** `NANACHI_HOME` ou `%USERPROFILE%\.nanachi-remote`. */
export function resolveNanachiHome(env: NodeJS.ProcessEnv): string {
  return env.NANACHI_HOME ?? join(homedir(), '.nanachi-remote');
}

/**
 * Lê `<home>/config.json`. Se não existir, cria com os defaults e o hostname.
 * Valida com ConfigSchema e lança erro citando config.json quando inválido.
 */
export function loadConfig(home: string): LoadedConfig {
  mkdirSync(home, { recursive: true });
  const file = join(home, 'config.json');

  if (!existsSync(file)) {
    const defaults = ConfigSchema.parse({ machineName: hostname() });
    writeFileSync(file, `${JSON.stringify(defaults, null, 2)}\n`, 'utf8');
    return { ...defaults, machineName: hostname() };
  }

  let raw: unknown;
  try {
    // PowerShell 5.1 grava BOM UTF-8; JSON.parse não aceita o BOM no começo.
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (error) {
    throw new Error(`config.json inválido (${file}): ${(error as Error).message}`, { cause: error });
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
    throw new Error(`config.json inválido (${file}): ${issues.join('; ')}`);
  }

  return { ...withDefaultAgents(parsed.data), machineName: parsed.data.machineName ?? hostname() };
}

/**
 * Avisos de configuração para o log de startup. Não bloqueiam: o daemon sobe mesmo assim.
 * Sem `allowedTailscaleLogins`, qualquer login do Tailscale que chegue pelo `tailscale serve` é aceito.
 */
export function startupWarnings(config: LoadedConfig): string[] {
  const warnings: string[] = [];
  if (config.allowedTailscaleLogins.length === 0) {
    warnings.push(
      'allowedTailscaleLogins vazio: defina allowedTailscaleLogins no config.json com seu login do Tailscale',
    );
  }
  return warnings;
}
