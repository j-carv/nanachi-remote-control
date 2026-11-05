import { win32 } from 'node:path';
import { existsSync } from 'node:fs';
import type { ShellId } from '@nanachi/shared';

/**
 * Shell que o terminal de workspace pode abrir, como achado neste PC. Windows only: as regras de caminho e de
 * PATH são as do Windows, que é onde o daemon roda.
 */
export interface ShellOption {
  id: ShellId;
  label: string;
  /** Caminho absoluto do executável, já achado. */
  file: string;
  args: readonly string[];
}

/** Ordem de preferência: o padrão é o primeiro desta lista que existe (ver defaultShellOf). */
const PREFERENCE: readonly ShellId[] = ['pwsh', 'powershell', 'cmd', 'bash'];

/** Variáveis do daemon que não podem chegar ao shell: tokens e endereços do próprio Nanachi. */
const PRIVATE_PREFIX = 'NANACHI_';

export interface FindShellsInput {
  env: NodeJS.ProcessEnv;
  /** Checa se um caminho existe. Testes passam um sistema de arquivos falso. */
  exists(path: string): boolean;
}

/** Procura `name` nas pastas do PATH (separador `;`). Devolve o primeiro caminho que existe. */
function findOnPath(env: NodeJS.ProcessEnv, exists: (path: string) => boolean, name: string): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(';')) {
    if (dir.trim().length === 0) continue;
    const candidate = win32.join(dir.trim(), name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Primeiro candidato que existe. Variáveis indefinidas viram candidatos ausentes (nunca `undefined\...`). */
function firstExisting(exists: (path: string) => boolean, candidates: ReadonlyArray<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && exists(candidate)) return candidate;
  }
  return undefined;
}

function systemRootOf(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
}

/**
 * Git Bash (Git for Windows): `Git\bin\bash.exe` em Program Files, Program Files (x86), LOCALAPPDATA ou ao lado do
 * `git.exe` do PATH (…\Git\cmd\git.exe → …\Git\bin\bash.exe). O `bash.exe` de System32 é o launcher do WSL e
 * fica de fora de propósito: o app não depende do WSL.
 */
function gitBashOf(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  const gitOnPath = findOnPath(env, exists, 'git.exe');
  const fromGitOnPath = gitOnPath === undefined ? undefined : win32.join(win32.dirname(win32.dirname(gitOnPath)), 'bin', 'bash.exe');
  return firstExisting(exists, [
    env.ProgramFiles === undefined ? undefined : win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] === undefined ? undefined : win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA === undefined ? undefined : win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    fromGitOnPath,
  ]);
}

/** Os shells deste PC, na ordem de preferência. Os que não existem não entram. */
export function findShells(input: FindShellsInput): ShellOption[] {
  const { env, exists } = input;
  const systemRoot = systemRootOf(env);
  const found: Partial<Record<ShellId, string | undefined>> = {
    pwsh: findOnPath(env, exists, 'pwsh.exe'),
    powershell: firstExisting(exists, [
      findOnPath(env, exists, 'powershell.exe'),
      win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ]),
    cmd: firstExisting(exists, [env.ComSpec, win32.join(systemRoot, 'System32', 'cmd.exe'), findOnPath(env, exists, 'cmd.exe')]),
    bash: gitBashOf(env, exists),
  };

  const labels: Record<ShellId, string> = {
    pwsh: 'PowerShell 7',
    powershell: 'Windows PowerShell',
    cmd: 'cmd.exe',
    bash: 'Git Bash',
  };
  const argsOf: Record<ShellId, readonly string[]> = {
    pwsh: ['-NoLogo'],
    powershell: ['-NoLogo'],
    cmd: [],
    bash: ['--login', '-i'],
  };

  const shells: ShellOption[] = [];
  for (const id of PREFERENCE) {
    const file = found[id];
    if (file !== undefined) shells.push({ id, label: labels[id], file, args: argsOf[id] });
  }
  return shells;
}

/** Padrão do terminal: o primeiro da lista de preferência que existe (pwsh, powershell, cmd, bash). */
export function defaultShellOf(shells: readonly ShellOption[]): ShellOption | undefined {
  for (const id of PREFERENCE) {
    const shell = shells.find((candidate) => candidate.id === id);
    if (shell !== undefined) return shell;
  }
  return undefined;
}

/** Shell pedido (ou o padrão quando não há pedido). Undefined: não existe no PC (shell_unavailable). */
export function chooseShell(shells: readonly ShellOption[], requested: ShellId | undefined): ShellOption | undefined {
  if (requested === undefined) return defaultShellOf(shells);
  return shells.find((shell) => shell.id === requested);
}

/** Os shells deste PC, como o daemon os acha de verdade (PATH, ComSpec, System32, Git for Windows). */
export function localShells(env: NodeJS.ProcessEnv = process.env): ShellOption[] {
  return findShells({ env, exists: existsSync });
}

/**
 * Ambiente do shell: o do usuário, sem nenhuma variável NANACHI_* (o daemon não passa token nem endereço a um shell
 * que o usuário abriu). Não altera o objeto de entrada.
 */
export function shellEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.toUpperCase().startsWith(PRIVATE_PREFIX)) continue;
    result[name] = value;
  }
  return result;
}
