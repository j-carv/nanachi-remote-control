import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Roda git de verdade num repositório de teste (identidade fixa; sem conversão de fim de linha). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'teste',
      GIT_AUTHOR_EMAIL: 'teste@exemplo.com',
      GIT_COMMITTER_NAME: 'teste',
      GIT_COMMITTER_EMAIL: 'teste@exemplo.com',
    },
  });
}

/** Escreve um arquivo (cria as pastas) dentro de `root`. */
export function writeIn(root: string, relative: string, content: string | Buffer): void {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Repositório novo na branch `branch`. Com `commit`, já tem um commit com `a.txt` e `remover.txt`. */
export function initRepo(dir: string, options: { commit?: boolean; branch?: string } = {}): void {
  const { commit = true, branch = 'main' } = options;
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.safecrlf', 'false');
  if (commit) {
    writeIn(dir, 'a.txt', 'linha 1\nlinha 2\nlinha 3\n');
    writeIn(dir, 'remover.txt', 'vai sumir\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'inicial');
  }
}
