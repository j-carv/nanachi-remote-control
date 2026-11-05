import { ApiError } from '../api.js';
import { t } from '../i18n/index.js';

/** A branch como a lista do drawer mostra (sem o campo `current`, que vem na própria linha). */
export interface BranchItem {
  name: string;
  current: boolean;
  upstream: string | null;
  /** Epoch ms of the last commit on the branch. */
  lastCommitAt: number;
}

/** Ordena pelo último commit (mais recente primeiro). Empate de data: pelo nome, para a ordem não oscilar. */
export function sortBranches(branches: readonly BranchItem[]): BranchItem[] {
  return [...branches].sort((a, b) => {
    if (a.lastCommitAt !== b.lastCommitAt) return b.lastCommitAt - a.lastCommitAt;
    return a.name.localeCompare(b.name);
  });
}

/** Busca simples: contém o texto, sem diferenciar maiúsculas. Texto só com espaço não filtra. */
export function filterBranches(branches: readonly BranchItem[], query: string): BranchItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...branches];
  return branches.filter((branch) => branch.name.toLowerCase().includes(needle));
}

/** Título do chip: a branch atual, ou "HEAD destacado" / "Detached HEAD" quando não há branch. */
export function branchTitle(head: { current: string | null; detachedAt: string | null }): string {
  return head.current ?? t('workspace:branches.detached');
}

/** Os primeiros `max` caminhos sujos e quantos ficaram de fora ("e mais N"). */
export function dirtyPreview(dirty: readonly string[], max: number): { shown: string[]; hidden: number } {
  return { shown: dirty.slice(0, max), hidden: Math.max(0, dirty.length - max) };
}

/** Arquivos sujos do erro `dirty_worktree` (`details.dirty`). Qualquer outro erro, ou lista inválida: nenhum. */
export function dirtyFilesOf(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== 'dirty_worktree') return [];
  const dirty = error.details?.dirty;
  return Array.isArray(dirty) ? dirty.filter((item): item is string => typeof item === 'string') : [];
}
