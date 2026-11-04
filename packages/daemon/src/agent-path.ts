import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `node_modules/.bin` do pacote do daemon e da raiz do monorepo, na ordem de prioridade, só os que existem.
 * `moduleUrl` é o próprio arquivo: src/ no dev (tsx) e dist/ no build têm a mesma profundidade.
 */
export function agentBinDirs(
  moduleUrl: string | URL = import.meta.url,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const daemonRoot = fileURLToPath(new URL('../', moduleUrl));
  const repoRoot = fileURLToPath(new URL('../../../', moduleUrl));
  return [join(daemonRoot, 'node_modules', '.bin'), join(repoRoot, 'node_modules', '.bin')].filter(exists);
}

/**
 * `packages/daemon/bin`: launchers `phone-send.cmd` e `phone-send`. Mesma profundidade em src/ e dist/.
 * Só os agentes do daemon recebem essa pasta no PATH; nada é instalado globalmente.
 */
export function phoneSendBinDir(moduleUrl: string | URL = import.meta.url): string {
  return fileURLToPath(new URL('../bin', moduleUrl));
}

/**
 * Devolve um env com `dirs` no início do PATH. No Windows a variável pode se chamar `Path` e um objeto
 * comum (não o process.env) não é case-insensitive: reaproveita a chave e não deixa duas. Se houver mais
 * de uma, vale a última (é a que veio do config do agente, depois do process.env).
 */
export function withPathPrepended(
  env: NodeJS.ProcessEnv,
  dirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (dirs.length === 0) return env;

  const isWindows = platform === 'win32';
  const isPathKey = (key: string): boolean => (isWindows ? key.toUpperCase() === 'PATH' : key === 'PATH');
  const keys = Object.keys(env).filter(isPathKey);
  const pathKey = keys.at(-1) ?? 'PATH';
  const current = env[pathKey];
  const value = [...dirs, ...(current ? [current] : [])].join(isWindows ? ';' : ':');

  const result: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(env)) {
    if (!isPathKey(key)) result[key] = entry;
  }
  result[pathKey] = value;
  return result;
}
