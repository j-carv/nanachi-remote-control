import * as nodeFs from 'node:fs';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { messageOf } from '../src/common/message.js';
import { removeTree, removeTreeOrThrow, type RemoveFs } from '../src/install/safe-remove.js';
import { makeJunction } from './install-support.js';

const instant = { sleep: (): void => undefined };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nanachi-safe-remove-'));
});
afterEach(() => {
  removeTree(root, nodeFs, instant);
});

function outsideFolder(): string {
  const outside = join(root, 'outside');
  mkdirSync(join(outside, 'sub'), { recursive: true });
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  writeFileSync(join(outside, 'sub', 'deep.txt'), 'deep');
  return outside;
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

describe('removeTree on the real file system', () => {
  it('removes files, nested folders and the folder itself', () => {
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'a', 'b'), { recursive: true });
    writeFileSync(join(tree, 'one.txt'), '1');
    writeFileSync(join(tree, 'a', 'b', 'two.txt'), '2');
    expect(removeTree(tree, nodeFs, instant)).toBe(true);
    expect(existsSync(tree)).toBe(false);
  });

  it('is true for a path that is not there', () => {
    expect(removeTree(join(root, 'ghost'), nodeFs, instant)).toBe(true);
  });

  it('removes a single file', () => {
    const file = join(root, 'one.txt');
    writeFileSync(file, 'x');
    expect(removeTree(file, nodeFs, instant)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it('removes a read-only file', () => {
    const tree = join(root, 'tree');
    mkdirSync(tree);
    const file = join(tree, 'readonly.txt');
    writeFileSync(file, 'x');
    chmodSync(file, 0o444);
    expect(removeTree(tree, nodeFs, instant)).toBe(true);
    expect(existsSync(tree)).toBe(false);
  });

  it('removes a junction inside the tree as a link and never enters it', () => {
    const outside = outsideFolder();
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'a.txt'), 'a');
    makeJunction(outside, join(tree, 'link'));
    makeJunction(outside, join(tree, 'sub', 'link2'));

    expect(removeTree(tree, nodeFs, instant)).toBe(true);
    expect(existsSync(tree)).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(join(outside, 'sub', 'deep.txt'), 'utf8')).toBe('deep');
  });

  it('removes a junction given as the path itself, and only the link', () => {
    const outside = outsideFolder();
    const junction = join(root, 'junction');
    makeJunction(outside, junction);
    expect(removeTree(junction, nodeFs, instant)).toBe(true);
    expect(lstatExists(junction)).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('removes a junction whose target is gone', () => {
    const outside = outsideFolder();
    const junction = join(root, 'dangling');
    makeJunction(outside, junction);
    removeTree(outside, nodeFs, instant);
    expect(removeTree(junction, nodeFs, instant)).toBe(true);
    expect(lstatExists(junction)).toBe(false);
  });

  it('removeTreeOrThrow throws when something stays', () => {
    expect(() => removeTreeOrThrow(join(root, 'ghost'), nodeFs, instant)).not.toThrow();
    const locked = join(root, 'locked.txt');
    writeFileSync(locked, 'x');
    const fs: RemoveFs = {
      ...nodeFs,
      unlinkSync: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
    };
    expect(() => removeTreeOrThrow(locked, fs, instant)).toThrow(/não foi possível remover/);
  });
});

/** A `RemoveFs` over a tiny in-memory tree, recording every call. */
function fakeFs(
  tree: Record<string, 'file' | 'dir' | 'link'>,
  hooks: { onUnlink?: (path: string) => void; onRmdir?: (path: string) => void; onChmod?: (path: string) => void } = {},
): { fs: RemoveFs; calls: string[]; entries: Map<string, 'file' | 'dir' | 'link'> } {
  const entries = new Map(Object.entries(tree));
  const calls: string[] = [];
  // `join` makes backslashes on Windows; the fake tree is written with forward slashes.
  const norm = (path: string): string => path.replace(/\\/g, '/');
  const stat = (path: string): ReturnType<RemoveFs['lstatSync']> => {
    const kind = entries.get(path);
    if (kind === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return { isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir' } as ReturnType<RemoveFs['lstatSync']>;
  };
  const childrenOf = (path: string): string[] =>
    [...entries.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).map((key) => key.slice(path.length + 1));
  const fs = {
    lstatSync: ((raw: string) => {
      const path = norm(raw);
      calls.push(`lstat ${path}`);
      return stat(path);
    }) as RemoveFs['lstatSync'],
    readdirSync: ((raw: string) => {
      const path = norm(raw);
      calls.push(`readdir ${path}`);
      return childrenOf(path);
    }) as RemoveFs['readdirSync'],
    unlinkSync: (raw: string) => {
      const path = norm(raw);
      calls.push(`unlink ${path}`);
      hooks.onUnlink?.(path);
      entries.delete(path);
    },
    rmdirSync: (raw: string) => {
      const path = norm(raw);
      calls.push(`rmdir ${path}`);
      hooks.onRmdir?.(path);
      if (childrenOf(path).length > 0) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
      entries.delete(path);
    },
    chmodSync: (raw: string) => {
      const path = norm(raw);
      calls.push(`chmod ${path}`);
      hooks.onChmod?.(path);
    },
  } as unknown as RemoveFs;
  return { fs, calls, entries };
}

describe('removeTree walker rules (fake file system)', () => {
  it('never lists a link: it is unlinked and its contents are not touched', () => {
    const { fs, calls, entries } = fakeFs({
      '/t': 'dir',
      '/t/link': 'link',
      '/t/link/secret.txt': 'file',
      '/t/a.txt': 'file',
    });
    expect(removeTree('/t', fs, instant)).toBe(true);
    expect(calls).not.toContain('readdir /t/link');
    expect(calls).toContain('unlink /t/link');
    expect(entries.has('/t/link/secret.txt')).toBe(true);
    expect(entries.has('/t')).toBe(false);
  });

  it('falls back to rmdir for a link that unlink refuses (EPERM), which is not recursive', () => {
    const { fs, calls } = fakeFs(
      { '/t': 'dir', '/t/link': 'link' },
      {
        onUnlink: (path) => {
          if (path === '/t/link') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
      },
    );
    expect(removeTree('/t', fs, instant)).toBe(true);
    expect(calls).toContain('rmdir /t/link');
  });

  it('retries a busy file and succeeds when it frees up', () => {
    let busy = 2;
    const waits: number[] = [];
    const { fs, entries } = fakeFs(
      { '/t': 'dir', '/t/a.txt': 'file' },
      {
        onUnlink: () => {
          if (busy > 0) {
            busy -= 1;
            throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          }
        },
      },
    );
    expect(removeTree('/t', fs, { sleep: (ms) => waits.push(ms), retryDelayMs: 100 })).toBe(true);
    // Linear back-off: 100 ms, then 200 ms.
    expect(waits).toEqual([100, 200]);
    expect(entries.size).toBe(0);
  });

  it('clears the read-only bit on EPERM and tries again', () => {
    let denied = true;
    const { fs, calls } = fakeFs(
      { '/t': 'dir', '/t/ro.txt': 'file' },
      {
        onUnlink: () => {
          if (denied) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        },
        onChmod: () => {
          denied = false;
        },
      },
    );
    expect(removeTree('/t', fs, instant)).toBe(true);
    expect(calls).toContain('chmod /t/ro.txt');
  });

  it('gives up on a file that stays busy, keeps going with its siblings and leaves the folder', () => {
    const { fs, entries } = fakeFs(
      { '/t': 'dir', '/t/held.exe': 'file', '/t/a.txt': 'file', '/t/sub': 'dir', '/t/sub/b.txt': 'file' },
      {
        onUnlink: (path) => {
          if (path === '/t/held.exe') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        },
      },
    );
    expect(removeTree('/t', fs, { ...instant, retries: 2 })).toBe(false);
    expect([...entries.keys()].sort()).toEqual(['/t', '/t/held.exe']);
  });

  it('does not retry an error that waiting cannot fix', () => {
    const waits: number[] = [];
    const { fs, calls } = fakeFs(
      { '/t': 'dir', '/t/a.txt': 'file' },
      {
        onUnlink: () => {
          throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
      },
    );
    expect(removeTree('/t', fs, { sleep: (ms) => waits.push(ms) })).toBe(false);
    expect(waits).toEqual([]);
    expect(calls.filter((call) => call === 'unlink /t/a.txt')).toHaveLength(1);
  });

  it('treats an entry that disappears meanwhile as removed', () => {
    // Somebody else deleted the file between the listing and the unlink.
    const built = fakeFs(
      { '/t': 'dir', '/t/a.txt': 'file' },
      {
        onUnlink: (path) => {
          built.entries.delete(path);
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      },
    );
    expect(removeTree('/t', built.fs, instant)).toBe(true);
  });
});

describe('messageOf', () => {
  it('reads Error, string, plain objects and falls back to String()', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf('connection reset')).toBe('connection reset');
    expect(messageOf({ message: 'from an object' })).toBe('from an object');
    expect(messageOf(undefined)).toBe('undefined');
    expect(messageOf(null)).toBe('null');
    expect(messageOf(42)).toBe('42');
    expect(messageOf({ message: 5 })).toBe('[object Object]');
  });
});

describe('no other recursive delete in the package', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  walk(join(here, '..', 'src'));
  walk(join(here, '..', 'installer'));
  walk(join(here, '..', 'scripts'));
  walk(here);

  /** The code without comments, so the explanations of why `rmSync` is banned do not trip the check. */
  function code(file: string): string {
    return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  it('fs.rmSync / fs.rm / rmdir with recursive, rimraf and cpSync appear nowhere (use removeTree)', () => {
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      if (file === fileURLToPath(import.meta.url)) continue;
      const text = code(file);
      expect(text, file).not.toMatch(/\bcpSync\(|\bfs\.cp\(|rimraf/);
      for (const call of text.matchAll(/\b(?:rmSync|rm|rmdirSync|rmdir)\(/g)) {
        const window = text.slice(call.index, call.index + 160);
        expect(window, `${file}: ${window}`).not.toMatch(/recursive/);
      }
    }
  });

  it('FsLike has no rmSync, so install and uninstall code cannot call it', () => {
    const install = code(join(here, '..', 'src', 'install', 'install.ts'));
    expect(install).not.toMatch(/'rmSync'/);
  });
});
