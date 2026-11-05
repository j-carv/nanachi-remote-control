import { useState } from 'react';
import {
  ChevronRight,
  File,
  FileBraces,
  FileCode,
  FileCog,
  FileImage,
  FileLock,
  FilePlus,
  FileTerminal,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceEntriesResponse, Workspace } from '@nanachi/shared';
import type { ApiClient } from '../api.js';
import { ActionSheetButton } from '../components/ActionSheet.js';
import { DeleteEntrySheet } from '../components/DeleteEntrySheet.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { ListGroup, listMainClass, listRowClass } from '../components/ListGroup.js';
import { NameSheet } from '../components/NameSheet.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Button } from '@/components/ui/button';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';
import { fileIconKindFor, type FileIconKind } from '../workspace/fileKinds.js';
import { breadcrumbs, formatSize, joinPath } from '../workspace/paths.js';

type Entry = WorkspaceEntriesResponse['entries'][number];

/** Folha aberta na tela: uma por vez. */
type Sheet =
  | { kind: 'newFile' }
  | { kind: 'newDir' }
  | { kind: 'rename'; entry: Entry }
  | { kind: 'delete'; entry: Entry };

interface FilesScreenProps {
  workspace: Workspace;
  /** Pasta aberta, relativa à raiz do workspace ("" = raiz). Vem da rota: voltar sobe uma pasta. */
  path: string;
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

/** Texto de uma linha: pasta, link, ou tamanho do arquivo. "Ignorado pelo git" fica na mesma linha. */
function metaOf(entry: Entry): string {
  const base = entry.type === 'dir' ? 'Pasta' : entry.type === 'symlink' ? 'Link' : formatSize(entry.size);
  return entry.ignored ? `${base} · ignorado pelo git` : base;
}

/** Ícone de uma linha: pasta, link, ou a família do arquivo (ver `fileIconKindFor`). */
type IconSlot = 'folder' | 'link' | FileIconKind;

const SLOT_ICONS: Readonly<Record<IconSlot, LucideIcon>> = {
  folder: Folder,
  link: Link2,
  code: FileCode,
  data: FileBraces,
  text: FileText,
  image: FileImage,
  terminal: FileTerminal,
  config: FileCog,
  lock: FileLock,
  generic: File,
};

function slotOf(entry: Entry): IconSlot {
  if (entry.type === 'dir') return 'folder';
  if (entry.type === 'symlink') return 'link';
  return fileIconKindFor(entry.name);
}

/**
 * Explorador do workspace: pastas primeiro, toque abre a pasta (ou o editor, no arquivo). Cada linha tem um "…"
 * com renomear, excluir e copiar caminho. Cabeçalho: atualizar, novo arquivo, nova pasta. As migalhas levam a
 * qualquer nível acima sem empilhar telas.
 */
export function FilesScreen({ workspace, path, api, nav, onRepair }: FilesScreenProps) {
  const list = useAsync(() => api.fsList(workspace.id, path), [api, workspace.id, path]);
  const [actionError, setActionError] = useState<unknown>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<unknown>(null);

  const entries = list.data ?? [];
  const crumbs = breadcrumbs(path, workspace.name);
  const title = path === '' ? 'Arquivos' : (crumbs[crumbs.length - 1]?.label ?? workspace.name);
  const folderLabel = path === '' ? workspace.name : path;
  const error = actionError ?? list.error;

  function openEntry(entry: Entry) {
    const child = joinPath(path, entry.name);
    if (entry.type === 'dir') {
      nav.push({ kind: 'files', workspace, path: child });
    } else {
      nav.push({ kind: 'editor', workspace, path: child });
    }
  }

  function closeSheet() {
    setSheet(null);
    setSheetError(null);
  }

  /** Roda uma ação de folha: fecha e recarrega a lista se der certo; senão mostra o erro dentro da folha. */
  async function runSheetAction(action: () => Promise<void>) {
    setBusy(true);
    setSheetError(null);
    try {
      await action();
      setSheet(null);
      list.reload();
    } catch (caught) {
      setSheetError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function copyPath(entry: Entry) {
    const full = joinPath(path, entry.name);
    try {
      await navigator.clipboard.writeText(full);
      setCopied(full);
      setActionError(null);
    } catch {
      setActionError(new Error('copy'));
    }
  }

  return (
    <Screen>
      <ScreenHeader
        title={title}
        subtitle={workspace.name}
        onBack={() => nav.back()}
        actions={
          <>
            <Button variant="ghost" size="icon" aria-label="Atualizar" title="Atualizar" onClick={() => list.reload()}>
              <RefreshCw aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Novo arquivo"
              title="Novo arquivo"
              onClick={() => setSheet({ kind: 'newFile' })}
            >
              <FilePlus aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Nova pasta"
              title="Nova pasta"
              onClick={() => setSheet({ kind: 'newDir' })}
            >
              <FolderPlus aria-hidden="true" />
            </Button>
          </>
        }
      />

      <nav aria-label="Caminho da pasta" className="-mx-1 flex min-w-0 items-center overflow-x-auto">
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <span key={crumb.path} className="flex shrink-0 items-center">
              {index > 0 && <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />}
              {current ? (
                <span aria-current="page" className="flex h-11 max-w-[11rem] items-center truncate px-2 font-semibold">
                  {crumb.label}
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="default"
                  className="h-11 max-w-[11rem] px-2 font-normal text-muted-foreground"
                  onClick={() => nav.replace({ kind: 'files', workspace, path: crumb.path })}
                >
                  <span className="truncate">{crumb.label}</span>
                </Button>
              )}
            </span>
          );
        })}
      </nav>

      <ErrorNotice error={error} onRepair={onRepair} />
      {copied !== null && <p className="pl-1 text-sm text-muted-foreground">Caminho copiado: {copied}</p>}

      {list.data === null && error === null && <p className="pl-1 text-muted-foreground">Carregando…</p>}
      {list.data !== null && entries.length === 0 && <p className="pl-1 text-muted-foreground">Pasta vazia.</p>}

      {entries.length > 0 && (
        <ListGroup label={`Conteúdo de ${folderLabel}`}>
          {entries.map((entry) => {
            const slot = slotOf(entry);
            const Icon = SLOT_ICONS[slot];
            return (
              <li key={entry.name}>
                <div className={listRowClass}>
                  <button
                    type="button"
                    className={`${listMainClass} py-1.5`}
                    onClick={() => openEntry(entry)}
                  >
                    <Icon
                      className={`size-5 shrink-0 ${entry.ignored ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}
                      aria-hidden="true"
                      data-icon={slot}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={`truncate text-base ${entry.ignored ? 'text-muted-foreground' : ''}`}>
                        {entry.name}
                      </span>
                      <span className="truncate text-sm text-muted-foreground tabular-nums">{metaOf(entry)}</span>
                    </span>
                  </button>
                  <ActionSheetButton
                    label={`Mais ações de ${entry.name}`}
                    title={entry.name}
                    items={[
                      { label: 'Renomear', onSelect: () => setSheet({ kind: 'rename', entry }) },
                      {
                        label: 'Excluir',
                        tone: 'danger',
                        onSelect: () => {
                          setSheetError(null);
                          setSheet({ kind: 'delete', entry });
                        },
                      },
                      { label: 'Copiar caminho', onSelect: () => void copyPath(entry) },
                    ]}
                  />
                </div>
              </li>
            );
          })}
        </ListGroup>
      )}

      {sheet?.kind === 'newFile' && (
        <NameSheet
          title="Novo arquivo"
          description={`Na pasta ${folderLabel}. O arquivo abre no editor logo depois de criado.`}
          submitLabel="Criar"
          initialName=""
          busy={busy}
          error={sheetError}
          onCancel={closeSheet}
          onSubmit={(name) => {
            const target = joinPath(path, name);
            void runSheetAction(async () => {
              await api.fsWriteFile(workspace.id, { path: target, content: '', baseEtag: null });
              setSheet(null);
              nav.push({ kind: 'editor', workspace, path: target });
            });
          }}
        />
      )}

      {sheet?.kind === 'newDir' && (
        <NameSheet
          title="Nova pasta"
          description={`Dentro de ${folderLabel}.`}
          submitLabel="Criar"
          initialName=""
          busy={busy}
          error={sheetError}
          onCancel={closeSheet}
          onSubmit={(name) => {
            void runSheetAction(() => api.fsMkdir(workspace.id, joinPath(path, name)));
          }}
        />
      )}

      {sheet?.kind === 'rename' && (
        <NameSheet
          title="Renomear"
          description={`Nome atual: ${sheet.entry.name}.`}
          submitLabel="Renomear"
          initialName={sheet.entry.name}
          busy={busy}
          error={sheetError}
          onCancel={closeSheet}
          onSubmit={(name) => {
            const entry = sheet.entry;
            void runSheetAction(() =>
              api.fsRename(workspace.id, joinPath(path, entry.name), joinPath(path, name)),
            );
          }}
        />
      )}

      {sheet?.kind === 'delete' && (
        <DeleteEntrySheet
          name={sheet.entry.name}
          isDir={sheet.entry.type === 'dir'}
          busy={busy}
          error={sheetError}
          onCancel={closeSheet}
          onConfirm={() => {
            const entry = sheet.entry;
            void runSheetAction(() => api.fsDelete(workspace.id, joinPath(path, entry.name)));
          }}
        />
      )}
    </Screen>
  );
}
