import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertOutsideRepo,
  BUILD_DIR_ENV,
  releaseDirOf,
  resolveBuildDir,
  stageDirOf,
} from '../src/main/build-dir.js';

describe('resolveBuildDir', () => {
  it('defaults to nanachi-desktop-build under LOCALAPPDATA', () => {
    expect(resolveBuildDir({ LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' }, 'C:\\Users\\other')).toBe(
      join('C:\\Users\\user\\AppData\\Local', 'nanachi-desktop-build'),
    );
  });

  it('falls back to <home>\\AppData\\Local when LOCALAPPDATA is missing or empty', () => {
    const expected = join('C:\\Users\\user', 'AppData', 'Local', 'nanachi-desktop-build');
    expect(resolveBuildDir({}, 'C:\\Users\\user')).toBe(expected);
    expect(resolveBuildDir({ LOCALAPPDATA: '' }, 'C:\\Users\\user')).toBe(expected);
  });

  it('NANACHI_DESKTOP_BUILD_DIR wins and must be absolute', () => {
    expect(BUILD_DIR_ENV).toBe('NANACHI_DESKTOP_BUILD_DIR');
    expect(resolveBuildDir({ [BUILD_DIR_ENV]: 'D:\\builds\\nanachi', LOCALAPPDATA: 'C:\\x' }, 'C:\\h')).toBe('D:\\builds\\nanachi');
    expect(() => resolveBuildDir({ [BUILD_DIR_ENV]: 'builds\\nanachi' }, 'C:\\h')).toThrow(/caminho absoluto/);
  });

  it('an empty override is ignored', () => {
    expect(resolveBuildDir({ [BUILD_DIR_ENV]: '', LOCALAPPDATA: 'C:\\L' }, 'C:\\h')).toBe(join('C:\\L', 'nanachi-desktop-build'));
  });
});

describe('assertOutsideRepo', () => {
  const repo = 'C:\\Users\\user\\OneDrive\\Área de Trabalho\\Nanachi-Remote';

  it('refuses the repository and anything inside it', () => {
    expect(() => assertOutsideRepo(repo, repo)).toThrow(/dentro do repositório/);
    expect(() => assertOutsideRepo(repo, join(repo, 'packages', 'desktop', 'stage'))).toThrow();
  });

  it('accepts folders next to the repository, on another drive, or only sharing a prefix', () => {
    expect(() => assertOutsideRepo(repo, 'C:\\Users\\user\\AppData\\Local\\nanachi-desktop-build')).not.toThrow();
    expect(() => assertOutsideRepo(repo, `${repo}-build`)).not.toThrow();
    expect(() => assertOutsideRepo(repo, 'D:\\builds')).not.toThrow();
  });
});

describe('stageDirOf and releaseDirOf', () => {
  it('put the stage and the release side by side in the build dir', () => {
    expect(stageDirOf('C:\\b')).toBe(join('C:\\b', 'stage'));
    expect(releaseDirOf('C:\\b')).toBe(join('C:\\b', 'release'));
  });
});
