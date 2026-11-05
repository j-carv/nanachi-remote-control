import { useEffect, useRef, useState } from 'react';
import { Redo2, TextWrap, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { redo, undo } from '@codemirror/commands';
import { EditorState, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Workspace } from '@nanachi/shared';
import { ApiError, type ApiClient } from '../api.js';
import { editorExtensions, languageCompartment, wrapCompartment } from '../editor/codemirror.js';
import { loadLanguage } from '../editor/languages.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { Screen } from '../components/Screen.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import type { Navigator } from '../navigation.js';
import { useAsync } from '../useAsync.js';
import { languageKeyFor, languageLabelFor } from '../workspace/fileKinds.js';

interface EditorScreenProps {
  workspace: Workspace;
  /** Arquivo aberto, relativo à raiz do workspace. */
  path: string;
  api: ApiClient;
  nav: Navigator;
  onRepair(): void;
}

/** Último segmento do caminho: o nome do arquivo. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Editor de um arquivo de texto do workspace (CodeMirror, carregado sob demanda). Salvar grava com o etag que
 * abriu o arquivo: se o PC mudou, a folha de conflito oferece recarregar ou sobrescrever. Voltar com alterações
 * pede confirmação.
 */
export function EditorScreen({ workspace, path, api, nav, onRepair }: EditorScreenProps) {
  const { t } = useTranslation('workspace');
  const file = useAsync(() => api.fsReadFile(workspace.id, path), [api, workspace.id, path]);
  const name = nameOf(path);
  const language = languageKeyFor(name);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** Documento como foi salvo (ou carregado). Comparar com ele diz se há alterações não salvas. */
  const savedRef = useRef<Text | null>(null);
  const etagRef = useRef<string | null>(null);
  const wrappingRef = useRef(true);
  const [wrapping, setWrapping] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  /** Etag atual do PC quando um salvar falhou com `file_changed`; null = sem conflito. */
  const [conflictEtag, setConflictEtag] = useState<string | null>(null);

  async function saveWith(baseEtag: string) {
    const view = viewRef.current;
    if (view === null || saving) return;
    const snapshot = view.state.doc;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.fsWriteFile(workspace.id, { path, content: snapshot.toString(), baseEtag });
      etagRef.current = result.etag;
      savedRef.current = snapshot;
      setConflictEtag(null);
      const current = viewRef.current;
      setDirty(current !== null && !current.state.doc.eq(snapshot));
    } catch (caught) {
      const etag = caught instanceof ApiError && caught.code === 'file_changed' ? caught.details?.etag : undefined;
      if (typeof etag === 'string') setConflictEtag(etag);
      else setSaveError(caught);
    } finally {
      setSaving(false);
    }
  }

  // Ctrl/Cmd+S chama a versão mais nova de `save`, sem recriar o editor a cada render.
  const saveRef = useRef<() => void>(() => undefined);
  saveRef.current = () => {
    if (etagRef.current !== null) void saveWith(etagRef.current);
  };

  // Cria o editor quando o arquivo chega. Recarregar do PC troca `file.data`, e o editor é refeito com o texto novo.
  useEffect(() => {
    const host = hostRef.current;
    const loaded = file.data;
    if (host === null || loaded === null) return;
    const state = EditorState.create({
      doc: loaded.content,
      extensions: [
        ...editorExtensions({
          wrapping: wrappingRef.current,
          onSave: () => saveRef.current(),
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && savedRef.current !== null) {
            setDirty(!update.state.doc.eq(savedRef.current));
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    savedRef.current = view.state.doc;
    etagRef.current = loaded.etag;
    setDirty(false);
    setSaveError(null);
    setConflictEtag(null);
    // O texto aparece já; o realce entra quando o parser da linguagem carrega (um pedaço sob demanda).
    let current = true;
    void loadLanguage(language).then((extension) => {
      if (current) view.dispatch({ effects: languageCompartment.reconfigure(extension) });
    });
    return () => {
      current = false;
      view.destroy();
      viewRef.current = null;
    };
  }, [file.data, language]);

  function toggleWrap() {
    const next = !wrappingRef.current;
    wrappingRef.current = next;
    setWrapping(next);
    viewRef.current?.dispatch({ effects: wrapCompartment.reconfigure(next ? EditorView.lineWrapping : []) });
  }

  function goBack() {
    if (dirty && !window.confirm(t('editor.discardConfirm'))) return;
    nav.back();
  }

  const error = saveError ?? file.error;

  return (
    <Screen>
      <ScreenHeader
        title={name}
        subtitle={path}
        onBack={goBack}
        meta={<Badge variant="outline">{languageLabelFor(language)}</Badge>}
      />

      {file.data !== null && (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label={t('editor.undo')} onClick={() => viewRef.current && undo(viewRef.current)}>
            <Undo2 aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t('editor.redo')} onClick={() => viewRef.current && redo(viewRef.current)}>
            <Redo2 aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('editor.wrap')}
            aria-pressed={wrapping}
            className={wrapping ? 'bg-accent' : undefined}
            onClick={toggleWrap}
          >
            <TextWrap aria-hidden="true" />
          </Button>
          <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 pr-1 text-sm text-muted-foreground" role="status">
            {dirty && (
              <>
                <span className="size-2 shrink-0 rounded-full bg-foreground" aria-hidden="true" />
                <span className="truncate">{t('editor.unsaved')}</span>
              </>
            )}
          </span>
          <Button
            disabled={!dirty || saving || etagRef.current === null}
            onClick={() => saveRef.current()}
          >
            {saving ? t('editor.saving') : t('editor.save')}
          </Button>
        </div>
      )}

      <ErrorNotice error={error} onRepair={onRepair} />
      {file.data === null && file.error === null && <p className="pl-1 text-muted-foreground">{t('states.loading', { ns: 'common' })}</p>}

      {file.data !== null && (
        <div
          ref={hostRef}
          aria-label={t('editor.label', { name })}
          className="h-[68dvh] min-h-64 overflow-hidden rounded-xl border border-border bg-card"
        />
      )}

      {conflictEtag !== null && (
        <Drawer
          open
          dismissible={!saving}
          onOpenChange={(open) => {
            if (!open && !saving) setConflictEtag(null);
          }}
        >
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>{t('editor.conflict.title')}</DrawerTitle>
              <DrawerDescription className="text-base leading-6 text-foreground/80">
                {t('editor.conflict.description')}
              </DrawerDescription>
            </DrawerHeader>
            <DrawerFooter>
              <Button variant="secondary" size="wide" onClick={() => {
                setConflictEtag(null);
                file.reload();
              }} disabled={saving}>
                {t('editor.conflict.reload')}
              </Button>
              <Button variant="destructive" size="wide" onClick={() => void saveWith(conflictEtag)} disabled={saving}>
                {saving ? t('editor.conflict.overwriting') : t('editor.conflict.overwrite')}
              </Button>
              <Button variant="ghost" size="wide" onClick={() => setConflictEtag(null)} disabled={saving}>
                {t('actions.cancel', { ns: 'common' })}
              </Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      )}
    </Screen>
  );
}
