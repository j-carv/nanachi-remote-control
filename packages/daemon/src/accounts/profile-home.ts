import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AccountAdapter, StateFileSpec } from './adapters.js';

/**
 * Pasta de uma conta extra (`<NANACHI_HOME>\accounts\<agente>\<conta>`). A principal nunca passa por aqui.
 * Compartilhado = junção para a principal (pastas) ou cópia da principal (arquivos); o resto é privado do perfil.
 */

export interface PrepareOptions {
  /** Arquivo de estado da principal (ex.: `.claude.json`), quando o adaptador tem `stateFile`. */
  principalStateFile?: string | undefined;
  /** Aviso para o log. Nada disso apaga dados: quando não dá para preparar algo, só avisa. */
  warn?: ((message: string) => void) | undefined;
}

type ReadJson =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'ok'; value: Record<string, unknown> };

/**
 * Prepara a pasta de um perfil antes de qualquer processo dele: junções para as pastas compartilhadas, cópia dos
 * arquivos compartilhados e mesclagem do estado (Claude `.claude.json`). Roda a cada preparo (idempotente).
 */
export async function prepareProfile(
  adapter: AccountAdapter,
  principalHome: string,
  profileHome: string,
  options: PrepareOptions = {},
): Promise<void> {
  const warn = options.warn ?? (() => undefined);
  await mkdir(profileHome, { recursive: true });

  // Nanachi never creates the principal home itself (it is the agent's own folder, e.g. %USERPROFILE%\.claude): without
  // it there is nothing to share, so the folders stay unlinked until the agent has made it.
  if (await isDirectory(principalHome)) {
    const linkOnlyIfPresent = adapter.linkOnlyIfPresent ?? [];
    for (const name of adapter.sharedDirs) {
      await linkSharedDir(join(principalHome, name), join(profileHome, name), warn, !linkOnlyIfPresent.includes(name));
    }
  } else {
    warn(`pasta da conta principal (${principalHome}) não existe; pastas compartilhadas não foram ligadas`);
  }
  for (const name of await adapter.sharedFiles(principalHome)) {
    await copySharedFile(join(principalHome, name), join(profileHome, name));
  }
  if (adapter.stateFile !== undefined && options.principalStateFile !== undefined) {
    await mergeStateFile(adapter.stateFile, options.principalStateFile, join(profileHome, adapter.stateFile.name), warn);
  }
}

/**
 * Garante que `link` é uma junção para `target`. Pasta da principal ausente é criada (vazia) quando `createTarget`; senão
 * não há o que ligar. Uma pasta real, ou uma junção para outro lugar, fica como está e gera aviso: nunca é apagada.
 * Another prepare (or the agent) can create `link` between the check and the create: EEXIST means "look again", and a
 * junction that is now the right one is fine.
 */
async function linkSharedDir(
  target: string,
  link: string,
  warn: (message: string) => void,
  createTarget: boolean,
): Promise<void> {
  if (createTarget) {
    await mkdir(target, { recursive: true });
  } else if (!(await isDirectory(target))) {
    return;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await lstatOrUndefined(link);
    if (current === undefined) {
      try {
        await linkDirectory(target, link);
        return;
      } catch (error) {
        if (errorCode(error) === 'EEXIST') continue;
        throw error;
      }
    }
    if (current.isSymbolicLink()) {
      const existing = await readlink(link).catch(() => undefined);
      if (existing !== undefined && samePath(existing, target)) return;
      warn(`junção em ${link} aponta para outro lugar; não foi trocada`);
      return;
    }
    warn(`${link} já existe e não é um link para a pasta principal; não foi mexida`);
    return;
  }
  warn(`não foi possível ligar ${link} à pasta principal: o caminho continua sendo criado por outro processo`);
}

/** Junção de diretório no Windows: não precisa de admin nem de modo desenvolvedor. */
function linkDirectory(target: string, link: string): Promise<void> {
  return symlink(target, link, 'junction');
}

/** Cópia do arquivo da principal sobrescrevendo o do perfil. Ausente na principal: deixa o do perfil como está. */
async function copySharedFile(source: string, destination: string): Promise<void> {
  const info = await lstatOrUndefined(source);
  if (info === undefined || !info.isFile()) return;
  await copyFile(source, destination);
}

/**
 * Copies only the shared keys of the principal state into the profile and writes atomically (temp file + rename).
 * Mirror semantics: a shared key that the principal does not have is removed from the profile, so the profile never keeps
 * a value the principal dropped; every other key of the profile (account, caches) is left alone. The file is written only
 * when a shared key actually differs: an unchanged file is not touched, so a Claude running on the profile is not
 * clobbered and nothing is renamed for nothing. Principal missing or invalid, or an invalid profile JSON: warn, write nothing.
 */
async function mergeStateFile(
  spec: StateFileSpec,
  principalFile: string,
  profileFile: string,
  warn: (message: string) => void,
): Promise<void> {
  const principal = await readJsonObject(principalFile);
  if (principal.kind !== 'ok') {
    warn(`estado da conta principal (${principalFile}) indisponível; mesclagem pulada`);
    return;
  }
  const profile = await readJsonObject(profileFile);
  if (profile.kind === 'invalid') {
    warn(`estado do perfil (${profileFile}) é JSON inválido; mesclagem pulada, arquivo intacto`);
    return;
  }

  const merged: Record<string, unknown> = profile.kind === 'ok' ? { ...profile.value } : {};
  let changed = false;
  for (const key of spec.sharedKeys) {
    if (Object.hasOwn(principal.value, key)) {
      if (!Object.hasOwn(merged, key) || !isDeepStrictEqual(merged[key], principal.value[key])) changed = true;
      merged[key] = principal.value[key];
    } else if (Object.hasOwn(merged, key)) {
      changed = true;
      delete merged[key];
    }
  }
  if (!changed) return;

  const temporary = `${profileFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    await rename(temporary, profileFile);
  } catch (error) {
    // The temp file would stay behind in the profile home: remove it before reporting the failure.
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Objeto JSON de um arquivo; ausente é `missing`, ilegível ou não-objeto é `invalid` (sem expor o conteúdo). */
async function readJsonObject(file: string): Promise<ReadJson> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return isNotFound(error) ? { kind: 'missing' } : { kind: 'invalid' };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { kind: 'ok', value: value as Record<string, unknown> };
    }
    return { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export interface RemoveOptions {
  /** Retries after the first attempt for a busy or locked entry (EBUSY, ENOTEMPTY, EPERM). Default 5. */
  retries?: number | undefined;
  /** Base of the linear backoff between retries, in ms (attempt N waits N times this). Default 100. */
  retryDelayMs?: number | undefined;
}

const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 100;
/** Errors Windows gives while another process (the agent, an indexer, an antivirus) still holds an entry. */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);

interface Retry {
  retries: number;
  delayMs: number;
}

/**
 * Apaga a pasta de um perfil. O caminho precisa estar exatamente em `<nanachiHome>\accounts\<agente>\<conta>`; qualquer
 * outro (principal, outra conta, a pasta do agente, `..`) é recusado sem apagar nada. Junções e links são removidos como
 * link, nunca seguidos: os arquivos da principal que eles mostram ficam intactos. A busy or read-only entry is retried
 * a few times, like `fs.rm` does (see RemoveOptions).
 */
export async function removeProfileHome(
  nanachiHome: string,
  agentId: string,
  profileHome: string,
  options: RemoveOptions = {},
): Promise<void> {
  const accountsRoot = resolve(nanachiHome, 'accounts', agentId);
  const target = resolve(profileHome);
  const rel = relative(accountsRoot, target);
  const segments = rel.split(/[\\/]/);
  const inside =
    rel !== '' && !isAbsolute(rel) && segments.length === 1 && segments[0] !== '..' && !rel.startsWith(`..${sep}`);
  if (!inside) {
    throw new Error(`pasta de conta fora de accounts\\${agentId}: recusada`);
  }

  const info = await lstatOrUndefined(target);
  if (info === undefined) return;
  await removeTree(target, {
    retries: options.retries ?? DEFAULT_RETRIES,
    delayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  });
}

/** Removes an owned tree without following symlinks or junctions. The caller validates the target. */
export async function removeTree(
  path: string,
  retry: Retry = { retries: DEFAULT_RETRIES, delayMs: DEFAULT_RETRY_DELAY_MS },
): Promise<void> {
  const info = await lstatOrUndefined(path);
  if (info === undefined) return;
  if (info.isSymbolicLink()) {
    await removeLink(path, retry);
    return;
  }
  if (info.isDirectory()) {
    await removeDirectory(path, retry);
    return;
  }
  await removeEntry(() => unlink(path), path, retry, true);
}

/**
 * Empties and removes a real directory. Errors of its children propagate as they are (each child already retried);
 * only the final `rmdir` is retried, listing the folder again each time because a late file may have appeared.
 */
async function removeDirectory(path: string, retry: Retry): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    for (const name of await readdir(path)) {
      await removeTree(join(path, name), retry);
    }
    try {
      await rmdir(path);
      return;
    } catch (error) {
      if (isNotFound(error)) return;
      if (!isRetryable(error) || attempt >= retry.retries) throw error;
      if (errorCode(error) === 'EPERM') await clearReadOnly(path);
      await delay(retry.delayMs * (attempt + 1));
    }
  }
}

/**
 * Runs `operation` on a path, retrying the errors a locked entry gives. EPERM clears the read-only attribute first, but
 * only when `clearAttribute` says the path is a real file or folder: chmod follows links, and a link is never touched.
 */
async function removeEntry(
  operation: () => Promise<void>,
  path: string,
  retry: Retry,
  clearAttribute: boolean,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (isNotFound(error)) return;
      if (!isRetryable(error) || attempt >= retry.retries) throw error;
      if (clearAttribute && errorCode(error) === 'EPERM') await clearReadOnly(path);
      await delay(retry.delayMs * (attempt + 1));
    }
  }
}

async function clearReadOnly(path: string): Promise<void> {
  await chmod(path, 0o666).catch(() => undefined);
}

/**
 * No Windows, uma junção de pasta não sai com `unlink`; `rmdir` remove só o link, não o conteúdo do alvo. Nothing here
 * ever looks inside the link or changes its attributes.
 */
async function removeLink(path: string, retry: Retry): Promise<void> {
  await removeEntry(
    async () => {
      try {
        await unlink(path);
      } catch (error) {
        if (isNotFound(error)) return;
        await rmdir(path);
      }
    },
    path,
    retry,
    false,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** A directory (a junction or symlink to one counts). Missing, or a file in the way, is false. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isRetryable(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && RETRYABLE_CODES.has(code);
}

/** Compara dois caminhos de pasta (o Windows ignora maiúsculas e aceita o prefixo `\\?\` de junção). */
function samePath(a: string, b: string): boolean {
  const normalize = (path: string): string => {
    const plain = resolve(path.replace(/^\\\\\?\\/, ''));
    return process.platform === 'win32' ? plain.toLowerCase() : plain;
  };
  return normalize(a) === normalize(b);
}
