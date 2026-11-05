import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Teto de saída de um comando git (listas grandes de arquivos). O limite de patches é outro, em session-diff. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Árvore vazia do git: compara com ela quando o repositório ainda não tem commit (HEAD inexistente). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitOptions {
  cwd: string;
  /** Teto de bytes de saída. Acima disso o comando falha. Padrão: 64 MiB. */
  maxBuffer?: number;
}

/**
 * Roda `git` com argumentos em array, sem shell, sem janela. Devolve a saída; rejeita se o comando sai com erro
 * (inclusive git ausente e repositório inexistente). `--literal-pathspecs`: nome com `*` ou `[` é nome, não padrão.
 */
export async function runGit(args: readonly string[], options: GitOptions): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--literal-pathspecs', ...args], {
    cwd: options.cwd,
    windowsHide: true,
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

/** A pasta está dentro de um work tree git (não conta a pasta `.git` em si). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await runGit(['rev-parse', '--is-inside-work-tree'], { cwd })).trim() === 'true';
  } catch {
    return false;
  }
}

/** O repositório já tem pelo menos um commit (HEAD resolve). */
export async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Nome da branch atual, ou null se o HEAD está destacado. Repo sem commit devolve a branch inicial. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const name = (await runGit(['symbolic-ref', '--short', '--quiet', 'HEAD'], { cwd })).trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Quantos arquivos têm mudança no cwd (e abaixo dele): modificados, removidos, no índice e não rastreados
 * (ignorados ficam de fora). Cada rename conta uma vez.
 */
export async function changedFileCount(cwd: string): Promise<number> {
  const out = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], { cwd });
  const fields = out.split('\0');
  let count = 0;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? '';
    if (entry.length === 0) continue;
    count += 1;
    // Rename no índice vem como `R  novo\0velho\0`: o campo seguinte é o caminho antigo, não outra entrada.
    if (entry.startsWith('R') || entry.startsWith('C')) i += 1;
  }
  return count;
}

/** `git worktree add -b <branch> <path> HEAD`. Cria as pastas que faltarem. */
export async function addWorktree(repo: string, path: string, branch: string): Promise<void> {
  await runGit(['worktree', 'add', '-b', branch, path, 'HEAD'], { cwd: repo });
}

/** Há mudança não commitada no worktree (modificado, no índice ou não rastreado; ignorado não conta). */
export async function isWorktreeDirty(path: string): Promise<boolean> {
  return (await runGit(['status', '--porcelain'], { cwd: path })).trim().length > 0;
}

/** `git worktree remove <path>` sem --force: recusa se o worktree estiver sujo. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await runGit(['worktree', 'remove', path], { cwd: repo });
}

/** Limpa o registro de worktrees cuja pasta sumiu. */
export async function pruneWorktrees(repo: string): Promise<void> {
  await runGit(['worktree', 'prune'], { cwd: repo });
}

/** `git branch -d`: só apaga se a branch já está mergeada. Quem chama decide o que fazer com a falha. */
export async function deleteMergedBranch(repo: string, branch: string): Promise<void> {
  await runGit(['branch', '-d', branch], { cwd: repo });
}

/** stderr text of a failed git command (empty when the error carries no stderr). */
export function stderrOf(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
  return typeof error.stderr === 'string' ? error.stderr : '';
}

/**
 * Which of the paths (relative to `cwd`) git ignores, in one call: `git check-ignore --stdin -z`.
 * Exit code 1 means "none matched" and is not an error. A tracked file does not count as ignored.
 */
export function checkIgnored(cwd: string, paths: readonly string[]): Promise<Set<string>> {
  if (paths.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    // No --literal-pathspecs: check-ignore rejects that mode (stdin already carries names, not pathspecs).
    const child = execFile(
      'git',
      ['check-ignore', '--stdin', '-z'],
      { cwd, windowsHide: true, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout) => {
        if (error !== null && error.code !== 1) {
          reject(error);
          return;
        }
        resolve(new Set(stdout.split('\0').filter((path) => path.length > 0)));
      },
    );
    // If git exits before reading all of stdin, the write fails with EPIPE. The callback reports the failure; it must not crash the daemon.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(`${paths.join('\0')}\0`);
  });
}
