import { describe, expect, it } from 'vitest';
import type { DriveInfo, RootEntry } from '../../src/common/control-api.js';
import {
  addRoots,
  buildDraftEntries,
  changeSummary,
  computeCoveredBy,
  driveLetter,
  driveSwitchState,
  driveUsage,
  needsRestartChoice,
  normalizeRootPath,
  pendingChanges,
  removeRoot,
  rootKey,
  splitPath,
  toggleDriveRoot,
} from '../../src/control/lib/roots.js';

describe('normalizeRootPath', () => {
  it.each([
    ['C:\\Projetos\\', 'C:\\Projetos'],
    ['C:/Projetos/nanachi', 'C:\\Projetos\\nanachi'],
    ['  D:\\Trabalho  ', 'D:\\Trabalho'],
    ['D:', 'D:\\'],
    ['d:\\', 'd:\\'],
    ['C:\\\\Projetos\\\\x', 'C:\\Projetos\\x'],
    ['\\\\servidor\\share\\', '\\\\servidor\\share'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeRootPath(input)).toBe(expected);
  });

  it('rootKey ignores case and trailing separators', () => {
    expect(rootKey('C:\\Projetos\\')).toBe(rootKey('c:\\projetos'));
  });
});

describe('computeCoveredBy', () => {
  it('flags entries inside another entry, case-insensitively', () => {
    const covered = computeCoveredBy(['C:\\Projetos', 'c:\\projetos\\nanachi\\app', 'D:\\Outro']);
    expect(covered).toEqual([null, 'C:\\Projetos', null]);
  });

  it('a drive root covers every folder of that drive', () => {
    expect(computeCoveredBy(['D:\\Trabalho', 'D:\\', 'E:\\x'])).toEqual(['D:\\', null, null]);
  });

  it('does not treat a name prefix as containment', () => {
    expect(computeCoveredBy(['C:\\Proj', 'C:\\Projetos'])).toEqual([null, null]);
  });

  it('points at the outermost covering entry', () => {
    expect(computeCoveredBy(['C:\\a\\b\\c', 'C:\\a\\b', 'C:\\a'])).toEqual(['C:\\a', 'C:\\a', null]);
  });

  it('a duplicate is covered by its first occurrence only', () => {
    expect(computeCoveredBy(['C:\\a', 'c:\\A\\'])).toEqual([null, 'C:\\a']);
  });
});

describe('buildDraftEntries', () => {
  const saved: RootEntry[] = [
    { path: 'C:\\Projetos', exists: true, coveredBy: null },
    { path: 'E:\\Antigos', exists: false, coveredBy: null },
  ];

  it('keeps exists from the saved entry, marks new ones and recomputes coveredBy locally', () => {
    const entries = buildDraftEntries(saved, ['C:\\Projetos', 'E:\\Antigos', 'C:\\Projetos\\novo']);
    expect(entries).toEqual([
      { path: 'C:\\Projetos', exists: true, coveredBy: null, isNew: false },
      { path: 'E:\\Antigos', exists: false, coveredBy: null, isNew: false },
      { path: 'C:\\Projetos\\novo', exists: true, coveredBy: 'C:\\Projetos', isNew: true },
    ]);
  });

  it('a saved entry stays "not new" when the path differs only in case', () => {
    expect(buildDraftEntries(saved, ['c:\\projetos'])[0]?.isNew).toBe(false);
  });
});

describe('addRoots / removeRoot', () => {
  it('appends in insertion order, normalised, without duplicates', () => {
    const result = addRoots(['C:\\Projetos'], ['D:/Trabalho/', 'c:\\projetos', 'D:\\Trabalho', 'E:\\x']);
    expect(result.next).toEqual(['C:\\Projetos', 'D:\\Trabalho', 'E:\\x']);
    expect(result.added).toEqual(['D:\\Trabalho', 'E:\\x']);
    expect(result.skipped).toEqual(['c:\\projetos', 'D:\\Trabalho']);
  });

  it('ignores blank picks', () => {
    expect(addRoots([], ['', '  ']).next).toEqual([]);
  });

  it('removes by key and keeps the rest in order', () => {
    expect(removeRoot(['C:\\a', 'D:\\b', 'E:\\c'], 'd:\\B\\')).toEqual(['C:\\a', 'E:\\c']);
  });
});

describe('pendingChanges', () => {
  it('is clean when the draft equals the saved list in any case or order', () => {
    expect(pendingChanges(['C:\\a', 'D:\\b'], ['d:\\B', 'C:\\a\\'])).toEqual({ added: [], removed: [], dirty: false });
  });

  it('reports added and removed paths', () => {
    expect(pendingChanges(['C:\\a', 'D:\\b'], ['C:\\a', 'E:\\c'])).toEqual({
      added: ['E:\\c'],
      removed: ['D:\\b'],
      dirty: true,
    });
  });

  it('removing everything is a change', () => {
    expect(pendingChanges(['C:\\a'], []).dirty).toBe(true);
  });
});

describe('changeSummary', () => {
  it.each([
    [{ added: ['x'], removed: [] }, '1 pasta adicionada'],
    [{ added: ['x', 'y', 'z'], removed: [] }, '3 pastas adicionadas'],
    [{ added: [], removed: ['x'] }, '1 pasta removida'],
    [{ added: [], removed: ['x', 'y'] }, '2 pastas removidas'],
    [{ added: ['x', 'y'], removed: ['z'] }, '2 adicionadas e 1 removida'],
    [{ added: [], removed: [] }, ''],
  ])('%j -> %s', (changes, text) => {
    expect(changeSummary({ ...changes, dirty: changes.added.length + changes.removed.length > 0 })).toBe(text);
  });
});

describe('drive switch', () => {
  it('is off with no entries on the drive', () => {
    expect(driveSwitchState('D:\\', ['C:\\a'])).toEqual({ checked: false, folderCount: 0 });
  });

  it('is on when the drive root itself is allowed (any spelling)', () => {
    expect(driveSwitchState('D:\\', ['c:\\a', 'd:/'])).toEqual({ checked: true, folderCount: 0 });
  });

  it('counts folders of the drive when only part of it is allowed', () => {
    expect(driveSwitchState('D:\\', ['D:\\Trabalho', 'd:\\Outro\\x', 'C:\\a'])).toEqual({ checked: false, folderCount: 2 });
  });

  it('counts the inner folders even when the whole drive is on', () => {
    expect(driveSwitchState('D:\\', ['D:\\', 'D:\\Trabalho'])).toEqual({ checked: true, folderCount: 1 });
  });

  it('toggling on adds the drive root and keeps the folders inside (they become redundant, not lost)', () => {
    expect(toggleDriveRoot(['D:\\Trabalho', 'C:\\a'], 'D:\\', true)).toEqual(['D:\\Trabalho', 'C:\\a', 'D:\\']);
  });

  it('toggling on twice does not duplicate', () => {
    expect(toggleDriveRoot(['d:\\'], 'D:\\', true)).toEqual(['d:\\']);
  });

  it('toggling off removes only the drive root', () => {
    expect(toggleDriveRoot(['D:\\', 'D:\\Trabalho', 'C:\\a'], 'D:\\', false)).toEqual(['D:\\Trabalho', 'C:\\a']);
  });
});

describe('drive helpers', () => {
  const drive = (extra: Partial<DriveInfo>): DriveInfo => ({
    root: 'C:\\',
    label: 'Windows',
    kind: 'fixed',
    totalBytes: 1000,
    freeBytes: 400,
    ...extra,
  });

  it('driveLetter', () => {
    expect(driveLetter('c:\\')).toBe('C:');
    expect(driveLetter('Z:\\')).toBe('Z:');
  });

  it('driveUsage reports used bytes and a level', () => {
    expect(driveUsage(drive({}))).toEqual({ used: 600, total: 1000, fraction: 0.6, level: 'normal' });
    expect(driveUsage(drive({ freeBytes: 100 }))?.level).toBe('high');
    expect(driveUsage(drive({ freeBytes: 20 }))?.level).toBe('critical');
  });

  it('driveUsage is null when sizes are unknown or the total is zero', () => {
    expect(driveUsage(drive({ totalBytes: null }))).toBeNull();
    expect(driveUsage(drive({ freeBytes: null }))).toBeNull();
    expect(driveUsage(drive({ totalBytes: 0, freeBytes: 0 }))).toBeNull();
  });

  it('driveUsage clamps a free size larger than the total', () => {
    expect(driveUsage(drive({ freeBytes: 2000 }))?.fraction).toBe(0);
  });
});

describe('needsRestartChoice', () => {
  it('asks only when sessions would be interrupted', () => {
    expect(needsRestartChoice(0)).toBe(false);
    expect(needsRestartChoice(1)).toBe(true);
  });
});

describe('splitPath', () => {
  it.each([
    ['D:\\', '', 'D:\\'],
    ['C:\\Projetos', 'C:\\', 'Projetos'],
    ['C:\\Projetos\\nanachi', 'C:\\Projetos\\', 'nanachi'],
    ['\\\\srv\\share\\x', '\\\\srv\\share\\', 'x'],
    ['solto', '', 'solto'],
  ])('%s -> parent %s, name %s', (path, parent, name) => {
    expect(splitPath(path)).toEqual({ parent, name });
  });
});
