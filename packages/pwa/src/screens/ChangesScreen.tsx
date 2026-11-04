import { useState } from 'react';
import type { SessionDiffResponse, Session, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { UnifiedPatchView } from '../components/UnifiedPatchView.js';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';

interface ChangesScreenProps {
  machineName: string;
  workspace: Workspace;
  session: Session;
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

type ChangedFile = SessionDiffResponse['files'][number];

const FILE_STATUS_TEXT: Record<ChangedFile['status'], string> = {
  added: 'Novo',
  modified: 'Alterado',
  deleted: 'Excluído',
  renamed: 'Renomeado',
};

/**
 * Alterações da sessão (`git diff HEAD` no cwd dela). A lista mostra status e +/−; tocar num
 * arquivo abre o patch dele logo abaixo. "Atualizar" refaz a consulta.
 */
export function ChangesScreen({
  machineName,
  workspace,
  session,
  api,
  nav,
  onRepair,
}: ChangesScreenProps) {
  const diff = useAsync(() => api.sessionDiff(session.id), [api, session.id]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const files = diff.data?.files ?? [];

  return (
    <main className="screen">
      <ScreenHeader
        title="Alterações"
        subtitle={`${workspace.name} · ${machineName}`}
        onBack={() => nav.back()}
        actions={
          <button type="button" className="button secondary header-button" onClick={diff.reload}>
            Atualizar
          </button>
        }
      />

      <ErrorNotice error={diff.error} onRepair={onRepair} />

      {diff.data?.truncated === true && (
        <p className="notice-inline" role="status">
          A lista foi cortada no limite de 1 MB. Os arquivos que faltam não aparecem aqui.
        </p>
      )}

      {diff.data === null && diff.error === null && <p className="muted">Carregando…</p>}
      {diff.data !== null && files.length === 0 && (
        <p className="muted">Nenhuma alteração nesta sessão.</p>
      )}

      <ul className="item-list">
        {files.map((file) => {
          const open = openPath === file.path;
          return (
            <li key={file.path} className="change-row">
              <button
                type="button"
                className="item-main"
                aria-expanded={open}
                onClick={() => setOpenPath(open ? null : file.path)}
              >
                <span className="item-meta">
                  <span className={`badge badge-${file.status}`}>{FILE_STATUS_TEXT[file.status]}</span>
                  <span className="change-counts">
                    <span className="diff-add-text">+{file.additions}</span>{' '}
                    <span className="diff-del-text">−{file.deletions}</span>
                  </span>
                </span>
                <span className="item-title path">{file.path}</span>
              </button>
              {open && <UnifiedPatchView patch={file.patch} />}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
