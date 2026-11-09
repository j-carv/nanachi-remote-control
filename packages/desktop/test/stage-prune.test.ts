import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pruneBuildOnlyFiles } from '../scripts/stage.js';
import { removeDir } from './remove-dir.js';

let runtime: string;
beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), 'nanachi-prune-'));
});
afterEach(() => {
  removeDir(runtime);
});

/** Writes a file below the runtime folder; `path` uses `/` separators. */
function write(path: string, content = 'content'): void {
  const full = join(runtime, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value));
}

function present(path: string): boolean {
  return existsSync(join(runtime, ...path.split('/')));
}

describe('pruneBuildOnlyFiles', () => {
  it('removes source maps, declaration files and Windows debug symbols from installed packages', () => {
    writeJson('node_modules/fastify/package.json', { name: 'fastify', main: 'fastify.js' });
    write('node_modules/fastify/fastify.js');
    write('node_modules/fastify/fastify.js.map');
    write('node_modules/fastify/types/index.d.ts');
    write('node_modules/fastify/types/index.d.mts');
    write('node_modules/fastify/types/index.d.cts');
    write('node_modules/fastify/README.md');
    write('node_modules/fastify/test/route.test.js');
    write('node_modules/fastify/lib/plain.ts');
    writeJson('node_modules/@lydell/node-pty-win32-x64/package.json', {
      name: '@lydell/node-pty-win32-x64',
      exports: './lib/index.js',
    });
    write('node_modules/@lydell/node-pty-win32-x64/lib/index.js');
    write('node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.node');
    write('node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.pdb');
    // Outside node_modules: the function never walks the daemon's own build.
    write('packages/daemon/dist/index.d.ts');

    pruneBuildOnlyFiles(runtime);

    for (const removed of [
      'node_modules/fastify/fastify.js.map',
      'node_modules/fastify/types/index.d.ts',
      'node_modules/fastify/types/index.d.mts',
      'node_modules/fastify/types/index.d.cts',
      'node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.pdb',
    ]) {
      expect(present(removed), removed).toBe(false);
    }
    for (const kept of [
      'node_modules/fastify/fastify.js',
      'node_modules/fastify/README.md',
      'node_modules/fastify/test/route.test.js',
      'node_modules/fastify/lib/plain.ts',
      'node_modules/@lydell/node-pty-win32-x64/lib/index.js',
      'node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty.node',
      'packages/daemon/dist/index.d.ts',
    ]) {
      expect(present(kept), kept).toBe(true);
    }
  });

  it("removes better-sqlite3's deps folder and the prebuilds of other platforms, and keeps its win32-x64 prebuild", () => {
    writeJson('node_modules/better-sqlite3/package.json', {
      name: 'better-sqlite3',
      main: 'lib/index.js',
      exports: { '.': './lib/index.js', './linux-x64': './lib/linux-x64.js', './win32-x64': './lib/win32-x64.js' },
    });
    write('node_modules/better-sqlite3/lib/index.js');
    write('node_modules/better-sqlite3/lib/linux-x64.js');
    write('node_modules/better-sqlite3/lib/win32-x64.js');
    write('node_modules/better-sqlite3/prebuilds/win32-x64.node');
    write('node_modules/better-sqlite3/prebuilds/win32-arm64.node');
    write('node_modules/better-sqlite3/prebuilds/linux-x64.node');
    write('node_modules/better-sqlite3/deps/sqlite3/sqlite3.c');
    write('node_modules/better-sqlite3/deps/copy.js');
    write('node_modules/better-sqlite3/README.md');

    pruneBuildOnlyFiles(runtime);

    expect(present('node_modules/better-sqlite3/deps')).toBe(false);
    expect(present('node_modules/better-sqlite3/prebuilds/linux-x64.node')).toBe(false);
    expect(present('node_modules/better-sqlite3/prebuilds/win32-arm64.node')).toBe(false);
    expect(present('node_modules/better-sqlite3/prebuilds/win32-x64.node')).toBe(true);
    expect(present('node_modules/better-sqlite3/lib/index.js')).toBe(true);
    expect(present('node_modules/better-sqlite3/lib/linux-x64.js')).toBe(true);
    expect(present('node_modules/better-sqlite3/README.md')).toBe(true);
  });

  it('keeps every file that package.json points at at runtime (main, bin, exports), whatever its extension', () => {
    writeJson('node_modules/keeper/package.json', {
      name: 'keeper',
      main: 'dist/entry.d.ts',
      bin: { keeper: './bin/keeper.map' },
      exports: { '.': { types: './types/api.d.ts', default: './dist/api.map' } },
    });
    write('node_modules/keeper/dist/entry.d.ts');
    write('node_modules/keeper/dist/api.map');
    write('node_modules/keeper/dist/other.map');
    write('node_modules/keeper/bin/keeper.map');
    write('node_modules/keeper/types/api.d.ts');

    pruneBuildOnlyFiles(runtime);

    expect(present('node_modules/keeper/dist/entry.d.ts')).toBe(true);
    expect(present('node_modules/keeper/dist/api.map')).toBe(true);
    expect(present('node_modules/keeper/bin/keeper.map')).toBe(true);
    // The `types` condition is only for the compiler: its declaration file goes.
    expect(present('node_modules/keeper/types/api.d.ts')).toBe(false);
    expect(present('node_modules/keeper/dist/other.map')).toBe(false);
  });

  it('keeps every file a wildcard export can match', () => {
    writeJson('node_modules/wild/package.json', { name: 'wild', exports: { './tools/*': './tools/*.pdb' } });
    write('node_modules/wild/tools/helper.pdb');
    write('node_modules/wild/tools/unused.pdb');

    pruneBuildOnlyFiles(runtime);

    expect(present('node_modules/wild/tools/helper.pdb')).toBe(true);
    expect(present('node_modules/wild/tools/unused.pdb')).toBe(true);
  });

  it('returns how many files and bytes it freed, and frees nothing on a second run', () => {
    writeJson('node_modules/a/package.json', { name: 'a', main: 'index.js' });
    write('node_modules/a/index.js', 'x'.repeat(100));
    write('node_modules/a/index.js.map', '0123456789'); // 10 bytes
    write('node_modules/a/index.d.ts', '1234567'); // 7 bytes
    write('node_modules/a/native.pdb', '12345'); // 5 bytes

    expect(pruneBuildOnlyFiles(runtime)).toEqual({ removedFiles: 3, freedBytes: 22 });
    expect(pruneBuildOnlyFiles(runtime)).toEqual({ removedFiles: 0, freedBytes: 0 });
  });
});
