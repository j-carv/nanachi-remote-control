import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceInfoResponse } from '@nanachi/shared';
import { changedFileCount, currentBranch, isGitRepo } from './git.js';

/** Arquivos de instrução que o PWA mostra como chips, na ordem do PLAN. */
export const INSTRUCTION_FILES: readonly string[] = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

/** Quais instruções existem na raiz (arquivo comum, não pasta). */
function instructionsIn(root: string): string[] {
  return INSTRUCTION_FILES.filter((name) => statSync(join(root, name), { throwIfNoEntry: false })?.isFile() === true);
}

/**
 * Contexto do workspace para o cabeçalho do PWA. Não-git: branch e changedFiles são null.
 * Com git: branch atual (null se HEAD destacado) e quantos arquivos têm mudança no cwd.
 */
export async function workspaceInfo(root: string): Promise<WorkspaceInfoResponse> {
  const instructions = instructionsIn(root);
  if (!(await isGitRepo(root))) return { branch: null, changedFiles: null, instructions };
  return {
    branch: await currentBranch(root),
    changedFiles: await changedFileCount(root),
    instructions,
  };
}
