import { createRequire } from 'node:module';

/**
 * Codex empacotado com o daemon: `@openai/codex` é dependência do `@agentclientprotocol/codex-acp`, então é resolvido a
 * partir do pacote do adaptador (o mesmo que o app-server usa), não do `PATH` do usuário.
 */
export function resolveBundledCodex(): string {
  const adapterManifest = createRequire(import.meta.url).resolve('@agentclientprotocol/codex-acp/package.json');
  return createRequire(adapterManifest).resolve('@openai/codex/bin/codex.js');
}

/** Programa e argumentos iniciais para rodar o codex: `file` + `prefixArgs` + os argumentos do comando. */
export interface CodexLauncher {
  file: string;
  prefixArgs: string[];
}

/**
 * Como rodar o codex: `CODEX_PATH` (env do agente) vence; senão o `node` atual com o `codex.js` empacotado. Sem shell.
 */
export function resolveCodexLauncher(env: NodeJS.ProcessEnv): CodexLauncher {
  const override = env.CODEX_PATH;
  if (override !== undefined && override !== '') return { file: override, prefixArgs: [] };
  return { file: process.execPath, prefixArgs: [resolveBundledCodex()] };
}
