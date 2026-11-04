import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export type PathErrorCode = 'outside_roots' | 'not_found' | 'not_a_directory';

/** Erro de caminho com código estável; a camada HTTP traduz para status e `{ error }`. */
export class PathError extends Error {
  readonly code: PathErrorCode;

  constructor(code: PathErrorCode, message: string) {
    super(message);
    this.name = 'PathError';
    this.code = code;
  }
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

/** Forma canônica para comparar caminhos: absoluto, separador normalizado, sem maiúsculas no Windows. */
function comparable(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** `target` é `root` ou está dentro dele. Compara por prefixo + separador: `a\bc` não está em `a\b`. */
function isInside(target: string, root: string): boolean {
  const t = comparable(target);
  const r = comparable(root);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Caminhos reais das raízes que existem. Raiz inexistente não libera nada. */
function realRoots(roots: readonly string[]): string[] {
  const real: string[] = [];
  for (const root of roots) {
    try {
      real.push(realpathSync.native(root));
    } catch {
      // raiz ausente: nada dentro dela é alcançável
    }
  }
  return real;
}

/**
 * Valida que `input` fica dentro de uma das raízes e devolve o caminho real (links e junctions resolvidos).
 * Ordem: lexical primeiro (sem revelar se um caminho externo existe), depois realpath (pega junctions que escapam).
 */
export function resolveInsideRoots(input: string, roots: readonly string[]): string {
  if (!isAbsolute(input)) {
    throw new PathError('outside_roots', 'caminho precisa ser absoluto');
  }

  const realBases = realRoots(roots);
  const lexical = resolve(input);
  if (![...roots, ...realBases].some((root) => isInside(lexical, root))) {
    throw new PathError('outside_roots', 'caminho fora das raízes permitidas');
  }

  let real: string;
  try {
    real = realpathSync.native(lexical);
  } catch {
    throw new PathError('not_found', 'pasta não encontrada');
  }

  if (!realBases.some((root) => isInside(real, root))) {
    throw new PathError('outside_roots', 'caminho fora das raízes permitidas (link ou junction)');
  }
  return real;
}

/** Raízes para o PWA: caminho absoluto e nome = última pasta (ou o próprio caminho, em unidade como `C:\`). */
export function describeRoots(roots: readonly string[]): Array<{ path: string; name: string }> {
  return roots.map((root) => {
    const path = resolve(root);
    return { path, name: basename(path) || path };
  });
}

const HIDDEN_DIRS = new Set(['node_modules']);

/**
 * Subpasta de `parent` que pode aparecer na listagem, ou null.
 * Arquivo fica de fora. Diretório, link, junction, reparse point do OneDrive e tipo desconhecido seguem
 * para `statSync` (que segue o link): conta se o alvo é diretório e, pelo realpath, fica dentro das raízes.
 * O `path` é o da entrada sob `parent` (navegável), não o realpath do alvo.
 * Qualquer erro ao ler a entrada (EPERM, EACCES, alvo sumiu) omite só essa entrada.
 */
function listableDirectory(parent: string, entry: Dirent, roots: readonly string[]): DirEntry | null {
  if (entry.isFile()) return null;
  const path = join(parent, entry.name);
  try {
    if (!statSync(path).isDirectory()) return null;
    resolveInsideRoots(path, roots);
    return { name: entry.name, path };
  } catch {
    return null;
  }
}

/**
 * Lista só subpastas de `input` (ordenadas, sem ocultas, sem node_modules, sem as que escapam das raízes).
 * `parent` é null quando `input` é uma raiz permitida.
 */
export function listDirectory(input: string, roots: readonly string[]): DirListing {
  const real = resolveInsideRoots(input, roots);
  if (!statSync(real).isDirectory()) {
    throw new PathError('not_a_directory', 'caminho não é uma pasta');
  }

  const isRoot = realRoots(roots).some((root) => comparable(root) === comparable(real));
  const dirs = readdirSync(real, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && !HIDDEN_DIRS.has(entry.name))
    .flatMap((entry) => {
      const dir = listableDirectory(real, entry, roots);
      return dir === null ? [] : [dir];
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));

  return { path: real, parent: isRoot ? null : dirname(real), dirs };
}
