import type { CommitEntry, SessionCommitResponse, SessionCommitsResponse } from '@nanachi/shared';
import { EMPTY_TREE, hasCommits, isGitRepo, runGit } from './git.js';
import { trackedChanges, trackedFiles, type DiffRange } from './session-diff.js';

/** Página padrão e teto da lista de commits. */
export const COMMITS_DEFAULT_LIMIT = 30;
export const COMMITS_MAX_LIMIT = 100;
/** `git log --skip` lê um inteiro de C: um deslocamento maior nem chega ao git, então a rota recusa antes. */
export const COMMITS_MAX_SKIP = 2_147_483_647;

/** Campos de cada commit no `git log`, separados pelo byte US (0x1f). Com `-z`, os registros são separados por NUL. */
const FIELD_SEPARATOR = '\x1f';
const LOG_FORMAT = '--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%at';

interface CommitRecord {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  /** Epoch ms (o `git log` dá segundos). */
  date: number;
}

/**
 * Um registro do `git log`. Hash, hash curto e assunto vêm no começo; autor e data, no fim. O corpo fica no meio, então
 * um corpo que contenha o byte US ainda separa certo as pontas.
 */
function parseRecord(record: string): CommitRecord | undefined {
  const fields = record.split(FIELD_SEPARATOR);
  if (fields.length < 6) return undefined;
  const [hash = '', shortHash = '', subject = ''] = fields;
  const author = fields[fields.length - 2] ?? '';
  const seconds = Number(fields[fields.length - 1] ?? '');
  const body = fields.slice(3, fields.length - 2).join(FIELD_SEPARATOR);
  return { hash, shortHash, subject, body: body.trim(), author, date: seconds * 1000 };
}

/** A primeira linha não vazia do corpo, aparada; null quando o corpo não tem texto. */
export function summaryOf(body: string): string | null {
  return body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? null;
}

function toEntry(record: CommitRecord): CommitEntry {
  return {
    hash: record.hash,
    shortHash: record.shortHash,
    subject: record.subject,
    summary: summaryOf(record.body),
    author: record.author,
    date: record.date,
  };
}

/**
 * Uma página do histórico de HEAD, do mais novo para o mais antigo. Não-git ou repositório sem commit → página vazia.
 * `hasMore` vem de um commit a mais que a página pede, sem outra chamada ao git.
 */
export async function sessionCommits(cwd: string, page: { skip: number; limit: number }): Promise<SessionCommitsResponse> {
  if (!(await isGitRepo(cwd)) || !(await hasCommits(cwd))) return { commits: [], hasMore: false };

  const out = await runGit(
    ['log', '-z', LOG_FORMAT, '--no-show-signature', `--skip=${page.skip}`, `--max-count=${page.limit + 1}`, 'HEAD', '--'],
    { cwd },
  );
  const records = out
    .split('\0')
    .filter((record) => record.length > 0)
    .flatMap((record) => {
      const parsed = parseRecord(record);
      return parsed === undefined ? [] : [parsed];
    });
  return {
    commits: records.slice(0, page.limit).map(toEntry),
    hasMore: records.length > page.limit,
  };
}

/**
 * Hash completo do commit que `ref` nomeia e o do primeiro pai (null num commit raiz). Nome que não é commit deste
 * repositório (inclusive hash ambíguo) → undefined; o `rev-list` sai com erro nesses casos.
 */
async function resolveCommit(cwd: string, ref: string): Promise<{ hash: string; parent: string | null } | undefined> {
  try {
    // `--parents` imprime o commit e depois os pais: uma chamada resolve o nome e acha o pai.
    const [hash, parent] = (await runGit(['rev-list', '--parents', '-n', '1', ref, '--'], { cwd })).trim().split(' ');
    if (hash === undefined || hash.length === 0) return undefined;
    return { hash, parent: parent ?? null };
  } catch {
    return undefined;
  }
}

/**
 * Um commit com os arquivos que mudou, comparados com o primeiro pai (com a árvore vazia, se for raiz). Mesmo limite de
 * 1 MiB do diff da sessão. `undefined` quando a pasta não é git ou `ref` não nomeia um commit dela.
 */
export async function sessionCommit(cwd: string, ref: string): Promise<SessionCommitResponse | undefined> {
  if (!(await isGitRepo(cwd))) return undefined;
  const resolved = await resolveCommit(cwd, ref);
  if (resolved === undefined) return undefined;

  const [record = ''] = (
    await runGit(['log', '-1', '-z', LOG_FORMAT, '--no-show-signature', resolved.hash, '--'], { cwd })
  ).split('\0');
  const meta = parseRecord(record);
  if (meta === undefined) return undefined;

  const range: DiffRange = { revs: [resolved.parent ?? EMPTY_TREE, resolved.hash], relative: false };
  const tracked = await trackedFiles(cwd, range, await trackedChanges(cwd, range));
  return {
    hash: meta.hash,
    shortHash: meta.shortHash,
    subject: meta.subject,
    body: meta.body,
    author: meta.author,
    date: meta.date,
    files: tracked.files,
    truncated: tracked.truncated,
  };
}
