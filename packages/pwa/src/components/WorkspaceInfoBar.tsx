import { GitBranch } from '@phosphor-icons/react';
import type { WorkspaceInfoResponse } from '@nanachi/shared';
import { changesLabel } from './changesLabel.js';

interface WorkspaceInfoBarProps {
  /** null enquanto carrega ou se falhou: a barra some em silêncio. */
  info: WorkspaceInfoResponse | null;
}

/** Branch, alterações e arquivos de instrução do workspace (chips). Não-git sem instruções = nada. */
export function WorkspaceInfoBar({ info }: WorkspaceInfoBarProps) {
  if (info === null) return null;
  const hasBranch = info.branch !== null;
  const hasChanges = info.changedFiles !== null;
  if (!hasBranch && !hasChanges && info.instructions.length === 0) return null;

  return (
    <ul className="chip-row" aria-label="Estado do workspace">
      {info.branch !== null && (
        <li className="chip chip-branch">
          <GitBranch size={14} weight="bold" aria-hidden="true" />
          {info.branch}
        </li>
      )}
      {info.changedFiles !== null && (
        <li className="chip">{changesLabel(info.changedFiles)}</li>
      )}
      {info.instructions.map((file) => (
        <li key={file} className="chip chip-instruction">
          {file}
        </li>
      ))}
    </ul>
  );
}
