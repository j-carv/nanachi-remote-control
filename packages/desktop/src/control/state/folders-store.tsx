import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ControlResult, FoldersState } from '../../common/control-api.js';
import type { DaemonStatus } from '../../common/types.js';
import { addRoots, buildDraftEntries, pendingChanges, removeRoot, toggleDriveRoot, type DraftEntry, type PendingChanges } from '../lib/roots.js';
import { draftAfter, planSave, saveFolders, type SaveChoice, type SaveOutcome } from '../lib/save.js';
import { useApi } from './api.js';
import { settle, useResource, type Resource } from './resource.js';

export interface FoldersStore {
  resource: Resource<FoldersState>;
  /** The list on screen: the saved one until the user edits it. */
  entries: DraftEntry[];
  paths: string[];
  changes: PendingChanges;
  dirty: boolean;
  saving: boolean;
  add: (picked: string[]) => { added: number; skipped: number };
  remove: (path: string) => void;
  toggleDrive: (root: string, on: boolean) => void;
  discard: () => void;
  /**
   * Saves the edits. Main counts the busy sessions again before it restarts: `needs_confirmation` leaves the edits where
   * they are and updates the state (the count in `resource` is the fresh one), so the dialog shows what is true now.
   */
  save: (choice: SaveChoice) => Promise<SaveOutcome>;
  restart: () => Promise<ControlResult<DaemonStatus>>;
}

const FoldersContext = createContext<FoldersStore | null>(null);

export const FoldersProvider = FoldersContext.Provider;

export function useFolders(): FoldersStore {
  const store = useContext(FoldersContext);
  if (!store) throw new Error('useFolders outside FoldersProvider');
  return store;
}

/**
 * The folders editor's state, kept above the sections so that leaving the section does not lose edits. Edits are local
 * (`draft`) until `save`; the saved state comes from main and is loaded the first time the section is opened.
 */
export function useFoldersStore(enabled: boolean): FoldersStore {
  const api = useApi();
  const resource = useResource(() => api.folders.get(), { enabled });
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);

  const saved = resource.state.status === 'ready' ? resource.state.data : null;
  const editable = saved?.editable ?? false;
  const savedPaths = useMemo(() => saved?.roots.map((root) => root.path) ?? [], [saved]);
  const paths = draft ?? savedPaths;
  const entries = useMemo(() => buildDraftEntries(saved?.roots ?? [], paths), [saved, paths]);
  const changes = useMemo(() => pendingChanges(savedPaths, paths), [savedPaths, paths]);

  const add = useCallback(
    (picked: string[]): { added: number; skipped: number } => {
      if (!editable) return { added: 0, skipped: 0 };
      const result = addRoots(paths, picked);
      if (result.added.length > 0) setDraft(result.next);
      return { added: result.added.length, skipped: result.skipped.length };
    },
    [editable, paths],
  );
  const remove = useCallback(
    (path: string): void => {
      if (editable) setDraft(removeRoot(paths, path));
    },
    [editable, paths],
  );
  const toggleDrive = useCallback(
    (root: string, on: boolean): void => {
      if (editable) setDraft(toggleDriveRoot(paths, root, on));
    },
    [editable, paths],
  );
  const discard = useCallback((): void => setDraft((current) => draftAfter({ kind: 'discarded' }, current)), []);

  const { reload, setData } = resource;
  const shownBusy = saved?.busySessions ?? 0;
  const save = useCallback(
    async (choice: SaveChoice): Promise<SaveOutcome> => {
      setSaving(true);
      const outcome = await saveFolders(api, paths, planSave(choice, shownBusy));
      setSaving(false);
      // A confirmation request carries the state main just read (the busy count), and the edits stay.
      if (outcome.kind === 'saved' || outcome.kind === 'needs_confirmation') setData(outcome.state);
      setDraft((current) => draftAfter(outcome, current));
      return outcome;
    },
    [api, paths, shownBusy, setData],
  );
  const restart = useCallback(async () => {
    const result = await settle(() => api.restartDaemon());
    void reload(true);
    return result;
  }, [api, reload]);

  return { resource, entries, paths, changes, dirty: changes.dirty, saving, add, remove, toggleDrive, discard, save, restart };
}
