import { existsSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { DATA_DIR_NAME } from './constants.js';

/**
 * Path guards for the installer and the uninstaller. Both end up deleting folders, so every target goes through here
 * first: a drive root, the user profile (or anything above it), the Nanachi data folder and a folder that holds it are
 * never an install target, and nothing outside the install folder is ever removed with it.
 */

function key(path: string): string {
  const full = resolve(path);
  const root = parse(full).root;
  const trimmed = full.length > root.length ? full.replace(/[\\/]+$/, '') : full;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function samePath(a: string, b: string): boolean {
  return key(a) === key(b);
}

/** True when `child` is strictly below `parent`. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(key(parent), key(child));
  return rel !== '' && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface TargetContext {
  /** `os.homedir()`: the user profile. */
  profile: string;
  /** The daemon's data folder (`NANACHI_HOME`, default `%USERPROFILE%\.nanachi-remote`). */
  nanachiHome: string;
  /** Injected in tests. */
  exists?: (path: string) => boolean;
}

export type TargetCheck = { ok: true; dir: string } | { ok: false; reason: string };

/** Whether `input` may be used as an install folder. The reasons are shown to the user (Portuguese). */
export function checkInstallTarget(input: string, context: TargetContext): TargetCheck {
  const exists = context.exists ?? existsSync;
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
    return { ok: false, reason: 'Escolha uma pasta para instalar o Nanachi.' };
  }
  if (!isAbsolute(input)) return { ok: false, reason: 'O caminho da pasta precisa ser completo (por exemplo C:\\Programas\\Nanachi).' };
  const dir = resolve(input);
  if (parse(dir).root !== '' && samePath(dir, parse(dir).root)) {
    return { ok: false, reason: 'Escolha uma pasta dentro do disco, não a raiz dele.' };
  }
  if (samePath(dir, context.profile) || isInside(dir, context.profile)) {
    return { ok: false, reason: 'Escolha uma subpasta; a pasta do usuário (ou uma que a contém) não pode receber o Nanachi.' };
  }
  const dataProblem = 'Essa pasta guarda ou contém os dados do Nanachi (.nanachi-remote). Escolha outra.';
  if (samePath(dir, context.nanachiHome) || isInside(context.nanachiHome, dir) || isInside(dir, context.nanachiHome)) {
    return { ok: false, reason: dataProblem };
  }
  const segments = dir.split(sep).map((segment) => segment.toLowerCase());
  if (segments.includes(DATA_DIR_NAME) || exists(join(dir, DATA_DIR_NAME))) return { ok: false, reason: dataProblem };
  return { ok: true, dir };
}

/** A path with a drive letter or a UNC prefix: `\foo` and `C:foo` are rooted or drive-relative, so they depend on the cwd. */
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/]+[^\\/])/;

function isFullyQualified(input: string): boolean {
  return process.platform === 'win32' ? WINDOWS_ABSOLUTE.test(input) : isAbsolute(input);
}

export interface DataFolderContext {
  /** `os.homedir()`. */
  profile: string;
  /** The install folder that is being uninstalled: data and program never overlap. */
  installDir: string;
  /** Other folders that must not be this one (the Desktop profile when checking `NANACHI_HOME`, and the reverse). */
  others?: readonly string[];
  /** Every one of these must exist in the folder. */
  requireAll?: readonly string[];
  /** At least one of these must exist in the folder. */
  requireAny?: readonly string[];
  exists?: (path: string) => boolean;
}

export type DataFolderCheck = { ok: true; dir: string } | { ok: false; reason: string };

/**
 * Whether `input` may be deleted as a Nanachi data folder (`NANACHI_HOME`, Desktop's profile). The path must be complete
 * (never resolved against the cwd: an empty or relative `NANACHI_HOME` is refused, not guessed), must not be a drive
 * root, the user profile or something that holds it, and must look like what Nanachi writes there.
 */
export function checkDataFolder(input: string, context: DataFolderContext): DataFolderCheck {
  const exists = context.exists ?? existsSync;
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) {
    return { ok: false, reason: 'o caminho está vazio' };
  }
  if (!isFullyQualified(input)) return { ok: false, reason: 'o caminho não é completo (como C:\\Dados\\Nanachi)' };
  const dir = resolve(input);
  if (samePath(dir, parse(dir).root)) return { ok: false, reason: 'é a raiz de um disco' };
  if (samePath(dir, context.profile) || isInside(dir, context.profile)) {
    return { ok: false, reason: 'é a pasta do usuário ou uma pasta que a contém' };
  }
  if (samePath(dir, context.installDir) || isInside(dir, context.installDir) || isInside(context.installDir, dir)) {
    return { ok: false, reason: 'se mistura com a pasta do programa' };
  }
  for (const other of context.others ?? []) {
    if (typeof other === 'string' && other !== '' && (samePath(dir, other) || isInside(dir, other) || isInside(other, dir))) {
      return { ok: false, reason: 'se mistura com outra pasta de dados do Nanachi' };
    }
  }
  for (const name of context.requireAll ?? []) {
    if (!exists(join(dir, name))) return { ok: false, reason: `não tem ${name}, então não parece uma pasta de dados do Nanachi` };
  }
  const any = context.requireAny ?? [];
  if (any.length > 0 && !any.some((name) => exists(join(dir, name)))) {
    return { ok: false, reason: 'não parece uma pasta de dados do Nanachi' };
  }
  return { ok: true, dir };
}

/** Throws unless `candidate` is strictly inside `installDir`. Every removal below the install folder goes through it. */
export function assertInsideInstall(installDir: string, candidate: string): void {
  if (!isInside(installDir, candidate)) {
    throw new Error(`recusado: ${candidate} fica fora de ${installDir}`);
  }
}
