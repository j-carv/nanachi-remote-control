import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * Forma de chamar `spawn`. Com `shell: true` (só `.cmd`/`.bat` no Windows, porque Node 22 recusa esses
 * arquivos sem shell), `file` já é a linha de comando completa e `args` fica vazio.
 */
export interface AgentCommand {
  file: string;
  args: string[];
  shell: boolean;
}

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
/** Caracteres que o cmd.exe não interpreta: argumento só com eles vai sem aspas. */
const CMD_SAFE_ARG = /^[\w@+=:,./\\-]+$/;

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** Aspas para uma linha de comando do cmd.exe; `"` vira `\"` (regra do MSVCRT que o Node usa). */
function quoteForCmd(arg: string): string {
  return CMD_SAFE_ARG.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Procura o executável no PATH. No Windows, testa as extensões de PATHEXT e nunca o nome nu
 * (o npm cria um script sh sem extensão ao lado do `.cmd`, e esse não roda).
 */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const isWindows = platform === 'win32';
  const hasPathPart = isAbsolute(command) || /[\\/]/.test(command);
  const dirs = hasPathPart ? [''] : (env.PATH ?? env.Path ?? '').split(isWindows ? ';' : ':').filter(Boolean);

  let candidates: string[];
  if (!isWindows) {
    candidates = [command];
  } else {
    const exts = (env.PATHEXT ?? WINDOWS_DEFAULT_PATHEXT).split(';').filter(Boolean);
    const hasExt = exts.some((ext) => command.toLowerCase().endsWith(ext.toLowerCase()));
    candidates = hasExt ? [command] : exts.map((ext) => `${command}${ext.toLowerCase()}`);
  }

  for (const dir of dirs) {
    for (const name of candidates) {
      const path = dir === '' ? name : join(dir, name);
      if (isFile(path)) return path;
    }
  }
  return undefined;
}

/**
 * Resolve `command` para o que `spawn` precisa. Lança erro se o executável não existe.
 * `platform` é parâmetro para teste; em produção é `process.platform`.
 */
export function resolveAgentCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): AgentCommand {
  const file = findExecutable(command, env, platform);
  if (file === undefined) {
    throw new Error(`executável do agente não encontrado no PATH: ${command}`);
  }

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    return { file: [quoteForCmd(file), ...args.map(quoteForCmd)].join(' '), args: [], shell: true };
  }
  return { file, args: [...args], shell: false };
}
