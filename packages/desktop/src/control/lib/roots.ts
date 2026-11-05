/**
 * View-model of the folders editor: everything the screen decides about `allowedRoots` before main sees it. Main
 * validates and normalises again on save (it is the authority); these helpers only keep the local draft honest, so the
 * user sees duplicates, redundant entries and pending changes as they edit. Windows paths, compared case-insensitively.
 */
import type { DriveInfo, RootEntry } from '../../common/control-api.js';
import type { ControlT } from '../i18n.js';

/** One row of the draft list. `coveredBy` is recomputed locally on every edit. */
export interface DraftEntry {
  path: string;
  exists: boolean;
  coveredBy: string | null;
  /** Added in this editing session, not saved yet. */
  isNew: boolean;
}

export interface PendingChanges {
  added: string[];
  removed: string[];
  dirty: boolean;
}

/** `C:\Projetos\`, `C:/Projetos`, `D:` -> `C:\Projetos`, `C:\Projetos`, `D:\`. Case is kept. */
export function normalizeRootPath(input: string): string {
  let path = input.trim().replace(/\//g, '\\');
  const unc = path.startsWith('\\\\');
  path = path.replace(/\\{2,}/g, '\\');
  if (unc) path = `\\${path}`;
  if (/^[a-z]:$/i.test(path)) return `${path}\\`;
  if (/^[a-z]:\\$/i.test(path)) return path;
  return path.replace(/\\+$/, '');
}

/** The folder name and what comes before it, so a long path can truncate its parent and keep the name visible. */
export function splitPath(path: string): { parent: string; name: string } {
  if (/^[a-z]:\\$/i.test(path)) return { parent: '', name: path };
  const cut = path.lastIndexOf('\\');
  if (cut === -1) return { parent: '', name: path };
  return { parent: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** The comparison key: normalised and lower-cased (NTFS is case-insensitive). */
export function rootKey(path: string): string {
  return normalizeRootPath(path).toLowerCase();
}

function contains(parentKey: string, childKey: string): boolean {
  if (childKey.length <= parentKey.length) return false;
  return childKey.startsWith(parentKey.endsWith('\\') ? parentKey : `${parentKey}\\`);
}

/**
 * For each path, the outermost other entry that already contains it (a redundant entry, still allowed), or null. An exact
 * duplicate is covered by its first occurrence only, never both ways.
 */
export function computeCoveredBy(paths: readonly string[]): Array<string | null> {
  const keys = paths.map(rootKey);
  return paths.map((_, index) => {
    const key = keys[index] ?? '';
    let best = -1;
    keys.forEach((other, candidate) => {
      if (candidate === index) return;
      const covers = other === key ? candidate < index : contains(other, key);
      if (!covers) return;
      if (best === -1 || other.length < (keys[best] ?? '').length) best = candidate;
    });
    const covering = best === -1 ? undefined : paths[best];
    return covering === undefined ? null : normalizeRootPath(covering);
  });
}

/** The rows to draw: `exists` comes from the saved entry (a path picked now exists by definition), `coveredBy` from the draft. */
export function buildDraftEntries(saved: readonly RootEntry[], draft: readonly string[]): DraftEntry[] {
  const savedByKey = new Map(saved.map((entry) => [rootKey(entry.path), entry]));
  const covered = computeCoveredBy(draft);
  return draft.map((path, index) => {
    const known = savedByKey.get(rootKey(path));
    return { path, exists: known ? known.exists : true, coveredBy: covered[index] ?? null, isNew: known === undefined };
  });
}

/** Appends picked folders in insertion order, normalised and without duplicates. `skipped` were already there. */
export function addRoots(current: readonly string[], picked: readonly string[]): { next: string[]; added: string[]; skipped: string[] } {
  const next = [...current];
  const seen = new Set(current.map(rootKey));
  const added: string[] = [];
  const skipped: string[] = [];
  for (const raw of picked) {
    const path = normalizeRootPath(raw);
    if (path === '') continue;
    const key = rootKey(path);
    if (seen.has(key)) {
      skipped.push(path);
      continue;
    }
    seen.add(key);
    next.push(path);
    added.push(path);
  }
  return { next, added, skipped };
}

export function removeRoot(current: readonly string[], path: string): string[] {
  const key = rootKey(path);
  return current.filter((entry) => rootKey(entry) !== key);
}

/** What saving would change, comparing as sets (the order of `allowedRoots` is not a user-visible thing). */
export function pendingChanges(saved: readonly string[], draft: readonly string[]): PendingChanges {
  const savedKeys = new Set(saved.map(rootKey));
  const draftKeys = new Set(draft.map(rootKey));
  const added: string[] = [];
  const removed: string[] = [];
  const counted = new Set<string>();
  for (const path of draft) {
    const key = rootKey(path);
    if (!savedKeys.has(key) && !counted.has(key)) {
      counted.add(key);
      added.push(path);
    }
  }
  for (const path of saved) {
    const key = rootKey(path);
    if (!draftKeys.has(key) && !counted.has(key)) {
      counted.add(key);
      removed.push(path);
    }
  }
  return { added, removed, dirty: added.length > 0 || removed.length > 0 };
}

/** `2 pastas adicionadas`, `1 pasta removida`, `2 adicionadas e 1 removida`; empty when nothing changed. */
export function changeSummary(changes: PendingChanges, t: ControlT): string {
  const added = changes.added.length;
  const removed = changes.removed.length;
  if (added > 0 && removed > 0) {
    return t('folders.changes.both', { added: t('folders.changes.addedShort', { count: added }), removed: t('folders.changes.removedShort', { count: removed }) });
  }
  if (added > 0) return t('folders.changes.added', { count: added });
  if (removed > 0) return t('folders.changes.removed', { count: removed });
  return '';
}

export interface DriveSwitchState {
  /** The drive root itself is in the list. */
  checked: boolean;
  /** Entries strictly inside the drive (redundant once `checked`). */
  folderCount: number;
}

export function driveSwitchState(driveRoot: string, draft: readonly string[]): DriveSwitchState {
  const driveKey = rootKey(driveRoot);
  let folderCount = 0;
  let checked = false;
  for (const path of draft) {
    const key = rootKey(path);
    if (key === driveKey) checked = true;
    else if (contains(driveKey, key)) folderCount += 1;
  }
  return { checked, folderCount };
}

/** Adds or removes the drive root only; folders inside the drive stay (they turn redundant, and come back when it is off). */
export function toggleDriveRoot(draft: readonly string[], driveRoot: string, on: boolean): string[] {
  const driveKey = rootKey(driveRoot);
  if (!on) return draft.filter((path) => rootKey(path) !== driveKey);
  if (draft.some((path) => rootKey(path) === driveKey)) return [...draft];
  return [...draft, normalizeRootPath(driveRoot)];
}

/** `C:` from `C:\`. */
export function driveLetter(root: string): string {
  return /^[a-z]:/i.test(root) ? root.slice(0, 2).toUpperCase() : root;
}

/** `Disco local`, `Removível`, `Rede`, `Óptico` or `Disco`, in the language of the page. */
export function driveKindLabel(kind: DriveInfo['kind'], t: ControlT): string {
  return t(`folders.drive.kind.${kind}`);
}

export interface DriveUsage {
  used: number;
  total: number;
  /** 0..1 */
  fraction: number;
  level: 'normal' | 'high' | 'critical';
}

/** Null when the volume does not report its size (a disconnected network drive, an empty card reader). */
export function driveUsage(drive: DriveInfo): DriveUsage | null {
  const { totalBytes: total, freeBytes: free } = drive;
  if (total === null || free === null || !(total > 0)) return null;
  const used = Math.max(0, total - Math.min(free, total));
  const fraction = used / total;
  return { used, total, fraction, level: fraction >= 0.95 ? 'critical' : fraction >= 0.85 ? 'high' : 'normal' };
}

/** A restart would interrupt sessions: the user picks between restarting now and applying later. */
export function needsRestartChoice(busySessions: number): boolean {
  return busySessions > 0;
}
