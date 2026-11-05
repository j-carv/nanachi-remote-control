import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertInside,
  assertNode22,
  bareImportsOf,
  buildRuntimePackageJson,
  copyTree,
  directorySize,
  findNpmCli,
  resolvePwaBuildDir,
  stagePaths,
} from '../scripts/stage.js';
import { removeDir } from './remove-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-desktop-stage-'));
});
afterEach(() => {
  removeDir(dir);
});

describe('stagePaths', () => {
  const script = new URL('../scripts/stage.ts', import.meta.url).href;

  it('defaults to a stage folder under LOCALAPPDATA, outside the repository', () => {
    const localAppData = join(dir, 'AppData', 'Local');
    const paths = stagePaths(script, { LOCALAPPDATA: localAppData });
    expect(paths.buildDir).toBe(join(localAppData, 'nanachi-desktop-build'));
    expect(paths.stageDir).toBe(join(localAppData, 'nanachi-desktop-build', 'stage'));
    expect(paths.runtimeDir).toBe(join(localAppData, 'nanachi-desktop-build', 'stage', 'runtime'));
    expect(paths.desktopDir).toBe(join(paths.repoRoot, 'packages', 'desktop'));
  });

  it('NANACHI_DESKTOP_BUILD_DIR overrides the build folder', () => {
    const custom = join(dir, 'custom build');
    const paths = stagePaths(script, { NANACHI_DESKTOP_BUILD_DIR: custom, LOCALAPPDATA: join(dir, 'ignored') });
    expect(paths.buildDir).toBe(custom);
    expect(paths.stageDir).toBe(join(custom, 'stage'));
    expect(paths.runtimeDir).toBe(join(custom, 'stage', 'runtime'));
  });

  it('refuses a build folder inside the repository (OneDrive) and a relative override', () => {
    const repoRoot = stagePaths(script, { LOCALAPPDATA: dir }).repoRoot;
    expect(() => stagePaths(script, { NANACHI_DESKTOP_BUILD_DIR: join(repoRoot, 'packages', 'desktop', 'stage') })).toThrow(/dentro do repositório/);
    expect(() => stagePaths(script, { NANACHI_DESKTOP_BUILD_DIR: repoRoot })).toThrow(/dentro do repositório/);
    expect(() => stagePaths(script, { NANACHI_DESKTOP_BUILD_DIR: 'relative/build' })).toThrow(/caminho absoluto/);
  });
});

describe('assertInside', () => {
  it('accepts paths below the stage folder and nothing else', () => {
    const stage = join(dir, 'stage');
    expect(() => assertInside(stage, join(stage, 'runtime', 'x'))).not.toThrow();
    expect(() => assertInside(stage, stage)).toThrow();
    expect(() => assertInside(stage, join(stage, '..', 'other'))).toThrow();
    expect(() => assertInside(stage, join(dir, 'stage-evil'))).toThrow();
    expect(() => assertInside(stage, join(stage, '..', '..', 'node_modules'))).toThrow();
    expect(() => assertInside(stage, 'C:\\Windows')).toThrow();
  });
});

describe('assertNode22', () => {
  it('accepts Node 22 only', () => {
    expect(() => assertNode22('22.23.2')).not.toThrow();
    expect(() => assertNode22('24.21.0')).toThrowError(/Node 22/);
    expect(() => assertNode22('20.19.0')).toThrow();
    expect(() => assertNode22('v22.0.0')).toThrow();
  });
});

describe('buildRuntimePackageJson', () => {
  it("keeps the daemon's dependencies, adds shared from the copied folder, and drops devDependencies", () => {
    const result = buildRuntimePackageJson({
      version: '1.2.3',
      dependencies: { fastify: '^5.0.0', 'better-sqlite3': '^13.0.3' },
      devDependencies: { tsx: '^4.0.0' },
    });
    expect(result).toEqual({
      name: 'nanachi-runtime',
      version: '1.2.3',
      private: true,
      description: 'Runtime staged by @nanachi/desktop. Generated; do not edit.',
      dependencies: { fastify: '^5.0.0', 'better-sqlite3': '^13.0.3', '@nanachi/shared': 'file:packages/shared' },
    });
  });

  it('rejects a daemon package.json without dependencies', () => {
    expect(() => buildRuntimePackageJson({ version: '1.0.0' })).toThrow();
    expect(() => buildRuntimePackageJson(null)).toThrow();
  });
});

describe('resolvePwaBuildDir', () => {
  function release(name: string): void {
    mkdirSync(join(dir, 'releases', name), { recursive: true });
    writeFileSync(join(dir, 'releases', name, 'index.html'), '<html>');
  }

  it('follows releases/current.json', () => {
    release('20261105T044119523Z-ab4464');
    writeFileSync(join(dir, 'releases', 'current.json'), '{"release":"20261105T044119523Z-ab4464"}');
    expect(resolvePwaBuildDir(dir)).toBe(join(dir, 'releases', '20261105T044119523Z-ab4464'));
  });

  it('falls back to dist when there is no pointer or it is unusable', () => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), '<html>');
    expect(resolvePwaBuildDir(dir)).toBe(join(dir, 'dist'));

    mkdirSync(join(dir, 'releases'), { recursive: true });
    writeFileSync(join(dir, 'releases', 'current.json'), '{ nope');
    expect(resolvePwaBuildDir(dir)).toBe(join(dir, 'dist'));
    writeFileSync(join(dir, 'releases', 'current.json'), '{"release":"missing"}');
    expect(resolvePwaBuildDir(dir)).toBe(join(dir, 'dist'));
  });

  it('refuses a pointer that tries to leave the releases folder', () => {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.html'), '<html>');
    mkdirSync(join(dir, 'releases'), { recursive: true });
    writeFileSync(join(dir, 'releases', 'current.json'), '{"release":"../dist"}');
    expect(resolvePwaBuildDir(dir)).toBe(join(dir, 'dist'));
  });

  it('fails when there is no build at all', () => {
    expect(() => resolvePwaBuildDir(dir)).toThrow(/build da PWA/);
  });
});

describe('findNpmCli', () => {
  const cli = (root: string): string => join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');

  it('prefers npm_execpath, then the folder of this Node, then PATH entries', () => {
    const present = new Set<string>();
    const exists = (path: string): boolean => present.has(path);

    expect(findNpmCli({}, 'C:\\node22\\node.exe', exists)).toBeNull();

    present.add(cli('C:\\Program Files\\nodejs'));
    expect(findNpmCli({ PATH: ['C:\\x', 'C:\\Program Files\\nodejs'].join(delimiter) }, 'C:\\node22\\node.exe', exists)).toBe(
      cli('C:\\Program Files\\nodejs'),
    );

    present.add(cli('C:\\node22'));
    expect(findNpmCli({ PATH: 'C:\\Program Files\\nodejs' }, 'C:\\node22\\node.exe', exists)).toBe(cli('C:\\node22'));

    const viaNpm = 'C:\\somewhere\\npm-cli.js';
    present.add(viaNpm);
    expect(findNpmCli({ npm_execpath: viaNpm }, 'C:\\node22\\node.exe', exists)).toBe(viaNpm);
  });

  it('ignores npm_execpath when it is not npm-cli.js (yarn, pnpm)', () => {
    expect(findNpmCli({ npm_execpath: 'C:\\yarn\\yarn.js' }, 'C:\\n\\node.exe', () => true)).toBe(cli('C:\\n'));
  });
});

describe('bareImportsOf', () => {
  it('finds packages in static, side-effect and dynamic imports and ignores relative paths and builtins', () => {
    const source = `
      import { a } from 'fastify';
      import b from "@fastify/static";
      import 'dotenv/config';
      import { c } from './local.js';
      import fs from 'node:fs';
      import path from 'path';
      export { d } from '@agentclientprotocol/sdk/schema';
      const e = await import('web-push');
      const f = await import('./x.js');
    `;
    expect(bareImportsOf(source)).toEqual(['@agentclientprotocol/sdk', '@fastify/static', 'dotenv', 'fastify', 'web-push']);
  });

  it('follows a multi-line import and ignores prose in comments and strings', () => {
    const source = [
      'import {',
      '  a,',
      '  b,',
      "} from 'pino';",
      '/**',
      ' * Login of one account: follows it from "starting" to a final state, then import "later".',
      ' */',
      "const text = 'import x from \"nope\"';",
    ].join('\n');
    expect(bareImportsOf(source)).toEqual(['pino']);
  });
});

describe('directorySize', () => {
  it('sums every file below the folder', () => {
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'one'), '12345');
    writeFileSync(join(dir, 'a', 'two'), '123');
    writeFileSync(join(dir, 'a', 'b', 'three'), '1');
    expect(directorySize(dir)).toBe(9);
  });
});

describe('copyTree', () => {
  it('copies nested folders, including from a path with accents (fs.cpSync crashes Node 22 there)', () => {
    const source = join(dir, 'Área de Trabalho', 'dist');
    mkdirSync(join(source, 'sub', 'deeper'), { recursive: true });
    writeFileSync(join(source, 'index.js'), 'a');
    writeFileSync(join(source, 'sub', 'b.js'), 'bb');
    writeFileSync(join(source, 'sub', 'deeper', 'c.js'), 'ccc');

    const target = join(dir, 'out', 'dist');
    copyTree(source, target);

    expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('a');
    expect(readFileSync(join(target, 'sub', 'b.js'), 'utf8')).toBe('bb');
    expect(readFileSync(join(target, 'sub', 'deeper', 'c.js'), 'utf8')).toBe('ccc');
  });
});
