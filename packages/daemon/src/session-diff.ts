import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiffFile, SessionDiffResponse } from '@nanachi/shared';
import { EMPTY_TREE, hasCommits, isGitRepo, runGit } from './git.js';

/** Soma dos patches de uma resposta. Passou disso, os patches seguintes ficam vazios e `truncated` vai para true. */
export const DIFF_MAX_BYTES = 1024 * 1024;
/** Não rastreado maior que isso não é lido (nem contado): só o stat. Evita ler um arquivo enorme por request. */
export const UNTRACKED_READ_MAX_BYTES = 1024 * 1024;

type FileStatus = DiffFile['status'];

interface Counts {
  additions: number;
  deletions: number;
}

export interface TrackedChange extends Counts {
  path: string;
  oldPath: string | undefined;
  status: FileStatus;
}

/**
 * What a `git diff` compares. `revs` is `[base]` (base against the working tree) or `[base, commit]` (two commits).
 * `relative` limits the paths to the cwd, as the session diff does; a commit's files are listed from the repository root.
 */
export interface DiffRange {
  readonly revs: readonly string[];
  readonly relative: boolean;
}

const NO_COUNTS: Counts = { additions: 0, deletions: 0 };

/** `-` (binário) e lixo viram 0. */
function countOf(value: string | undefined): number {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : 0;
}

/**
 * `git diff --numstat -z`: `add\tdel\tcaminho\0`; rename vem como `add\tdel\t\0antigo\0novo\0`.
 * Devolve as contagens pelo caminho novo.
 */
function parseNumstat(out: string): Map<string, Counts> {
  const fields = out.split('\0');
  const counts = new Map<string, Counts>();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    const match = /^([^\t]*)\t([^\t]*)\t(.*)$/s.exec(field);
    if (match === null) continue;
    const pair = { additions: countOf(match[1]), deletions: countOf(match[2]) };
    const path = match[3] ?? '';
    if (path === '') {
      counts.set(fields[i + 2] ?? '', pair);
      i += 2;
    } else {
      counts.set(path, pair);
    }
  }
  return counts;
}

function statusOf(code: string): FileStatus {
  if (code.startsWith('A') || code.startsWith('C')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  return 'modified';
}

/**
 * `git diff --name-status -z`: `M\0caminho\0`; rename/copy vem como `R100\0antigo\0novo\0`.
 * Sem as contagens: elas vêm do numstat.
 */
function parseNameStatus(out: string): Array<Omit<TrackedChange, keyof Counts>> {
  const fields = out.split('\0');
  const changes: Array<Omit<TrackedChange, keyof Counts>> = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i] ?? '';
    if (code === '') continue;
    const status = statusOf(code);
    if (code.startsWith('R') || code.startsWith('C')) {
      changes.push({ path: fields[i + 2] ?? '', oldPath: fields[i + 1] ?? '', status });
      i += 2;
    } else {
      changes.push({ path: fields[i + 1] ?? '', oldPath: undefined, status });
      i += 1;
    }
  }
  return changes;
}

function diffArgs(range: DiffRange, options: readonly string[]): string[] {
  return ['diff', ...range.revs, ...(range.relative ? ['--relative'] : []), ...options];
}

/** Arquivos rastreados que mudaram no intervalo (status, nomes, +/−). Sem patch: ver `trackedFiles`. */
export async function trackedChanges(cwd: string, range: DiffRange): Promise<TrackedChange[]> {
  const [numstat, nameStatus] = await Promise.all([
    runGit(diffArgs(range, ['--numstat', '-z', '-M']), { cwd }),
    runGit(diffArgs(range, ['--name-status', '-z', '-M']), { cwd }),
  ]);
  const counts = parseNumstat(numstat);
  return parseNameStatus(nameStatus).map((change) => ({ ...change, ...(counts.get(change.path) ?? NO_COUNTS) }));
}

async function untrackedPaths(cwd: string): Promise<string[]> {
  const out = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
  return out.split('\0').filter((path) => path.length > 0);
}

function isMaxBufferError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

/** Patch de um arquivo rastreado. `undefined` = não coube no que sobrou do limite. */
async function trackedPatch(cwd: string, range: DiffRange, change: TrackedChange, remaining: number): Promise<string | undefined> {
  if (remaining <= 0) return undefined;
  const paths = change.oldPath === undefined ? [change.path] : [change.oldPath, change.path];
  try {
    return await runGit([...diffArgs(range, ['-M', '--no-color', '--no-ext-diff']), '--', ...paths], {
      cwd,
      maxBuffer: remaining,
    });
  } catch (error) {
    if (isMaxBufferError(error)) return undefined;
    throw error;
  }
}

/**
 * Arquivos rastreados com o patch de cada um, enquanto a soma couber em `DIFF_MAX_BYTES`. Quem não cabe fica com patch
 * vazio e `truncated` vai para true; o que já coube continua. `used` é o total gasto, para quem soma mais arquivos.
 */
export async function trackedFiles(
  cwd: string,
  range: DiffRange,
  changes: readonly TrackedChange[],
): Promise<{ files: DiffFile[]; used: number; truncated: boolean }> {
  const files: DiffFile[] = [];
  let used = 0;
  let truncated = false;
  for (const change of changes) {
    const patch = await trackedPatch(cwd, range, change, DIFF_MAX_BYTES - used);
    if (patch === undefined) truncated = true;
    else used += Buffer.byteLength(patch, 'utf8');
    files.push({
      path: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      patch: patch ?? '',
    });
  }
  return { files, used, truncated };
}

/** Linhas e se há byte zero (binário), lendo em pedaços: o arquivo não entra inteiro na memória. */
async function scanFile(file: string): Promise<{ lines: number; binary: boolean }> {
  let lines = 0;
  let binary = false;
  let last: number | undefined;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    if (!binary && chunk.includes(0)) binary = true;
    let at = chunk.indexOf(0x0a);
    while (at !== -1) {
      lines += 1;
      at = chunk.indexOf(0x0a, at + 1);
    }
    last = chunk[chunk.length - 1] ?? last;
  }
  if (last !== undefined && last !== 0x0a) lines += 1;
  return { lines, binary };
}

/** Patch sintético de um arquivo novo (não rastreado), no formato que o `git diff` usaria. */
function addedPatch(path: string, content: string): string {
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
  if (content.length === 0) return header;
  const endsWithNewline = content.endsWith('\n');
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split('\n');
  let patch = `${header}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`;
  for (const line of lines) patch += `+${line}\n`;
  if (!endsWithNewline) patch += '\\ No newline at end of file\n';
  return patch;
}

function binaryPatch(path: string): string {
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`;
}

/**
 * Arquivo não rastreado: contagem de linhas sempre; patch só se couber em `remaining` bytes.
 * Link ou outro tipo não é lido (poderia apontar para fora do workspace): entra só com status added e sem patch.
 */
async function untrackedEntry(
  cwd: string,
  path: string,
  remaining: number,
): Promise<{ additions: number; patch: string | undefined }> {
  const file = join(cwd, path);
  const info = await lstat(file);
  if (!info.isFile()) return { additions: 0, patch: '' };
  if (info.size > UNTRACKED_READ_MAX_BYTES) return { additions: 0, patch: undefined };

  const scan = await scanFile(file);
  if (scan.binary) {
    const patch = binaryPatch(path);
    return { additions: 0, patch: Buffer.byteLength(patch, 'utf8') <= remaining ? patch : undefined };
  }
  if (info.size > remaining) return { additions: scan.lines, patch: undefined };

  const patch = addedPatch(path, (await readFile(file)).toString('utf8'));
  return { additions: scan.lines, patch: Buffer.byteLength(patch, 'utf8') <= remaining ? patch : undefined };
}

/**
 * Diff da pasta de uma sessão contra HEAD (ou contra a árvore vazia, sem commits), mais os não rastreados como
 * added. Não-git → sem arquivos. Tudo no cwd dado: com worktree, é o worktree.
 */
export async function sessionDiff(cwd: string): Promise<SessionDiffResponse> {
  if (!(await isGitRepo(cwd))) return { files: [], truncated: false };
  const base = (await hasCommits(cwd)) ? 'HEAD' : EMPTY_TREE;
  const range: DiffRange = { revs: [base], relative: true };

  const tracked = await trackedFiles(cwd, range, await trackedChanges(cwd, range));
  const files: DiffFile[] = tracked.files;
  let used = tracked.used;
  let truncated = tracked.truncated;
  const remaining = (): number => DIFF_MAX_BYTES - used;

  for (const path of await untrackedPaths(cwd)) {
    const entry = await untrackedEntry(cwd, path, remaining());
    if (entry.patch === undefined) truncated = true;
    else used += Buffer.byteLength(entry.patch, 'utf8');
    files.push({ path, status: 'added', additions: entry.additions, deletions: 0, patch: entry.patch ?? '' });
  }

  return { files, truncated };
}
