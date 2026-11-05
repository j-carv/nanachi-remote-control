import { FileText, GitBranch } from 'lucide-react';
import type { WorkspaceInfoResponse } from '@nanachi/shared';
import { Badge } from '@/components/ui/badge';
import { changesLabel } from './changesLabel.js';

interface WorkspaceInfoBarProps {
  /** null enquanto carrega ou se falhou: a barra some em silêncio. */
  info: WorkspaceInfoResponse | null;
  /** false quando outro controle já mostra a branch (o chip do cabeçalho do workspace). */
  showBranch?: boolean;
}

/** Branch, alterações e arquivos de instrução do workspace (chips). Não-git sem instruções = nada. */
export function WorkspaceInfoBar({ info, showBranch = true }: WorkspaceInfoBarProps) {
  if (info === null) return null;
  const hasBranch = showBranch && info.branch !== null;
  const hasChanges = info.changedFiles !== null;
  if (!hasBranch && !hasChanges && info.instructions.length === 0) return null;

  return (
    <ul className="flex flex-wrap gap-2" aria-label="Estado do workspace">
      {hasBranch && (
        <li>
          <Badge variant="outline" className="h-7 gap-1.5 px-2.5 font-mono text-xs text-foreground">
            <GitBranch aria-hidden="true" />
            {info.branch}
          </Badge>
        </li>
      )}
      {info.changedFiles !== null && (
        <li>
          <Badge variant="outline" className="h-7 px-2.5 text-xs text-foreground">
            {changesLabel(info.changedFiles)}
          </Badge>
        </li>
      )}
      {info.instructions.map((file) => (
        <li key={file}>
          <Badge variant="outline" className="h-7 gap-1.5 px-2.5 font-mono text-xs text-muted-foreground">
            <FileText aria-hidden="true" />
            {file}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
