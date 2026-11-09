import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertOutsideRepo, resolveBuildDir, stageDirOf } from '../src/main/build-dir.js';
import { removeTreeOrThrow } from '../src/install/safe-remove.js';

/**
 * Builds `<build dir>/stage/runtime`: the folder electron-builder ships as `resources/runtime`. The build dir is
 * `%LOCALAPPDATA%/nanachi-desktop-build` (override: `NANACHI_DESKTOP_BUILD_DIR`), outside the repository and OneDrive.
 * The runtime folder mirrors the monorepo layout (`packages/shared`, `packages/daemon`, `packages/pwa/dist`) next to
 * a `node_modules` installed *inside the stage folder* and a copy of the Node 22 that runs this script as `node.exe`.
 *
 * It builds nothing (with the live supervisor running its watch build already produced `dist`) and writes nothing
 * outside the stage folder.
 */

export interface StagePaths {
  repoRoot: string;
  desktopDir: string;
  /** `%LOCALAPPDATA%/nanachi-desktop-build`, or `NANACHI_DESKTOP_BUILD_DIR`. */
  buildDir: string;
  /** `<buildDir>/stage`: the sidecar goes to `bin`, the runtime to `runtime`. */
  stageDir: string;
  runtimeDir: string;
}

export function stagePaths(scriptUrl: string, env: NodeJS.ProcessEnv = process.env): StagePaths {
  const desktopDir = resolve(dirname(fileURLToPath(scriptUrl)), '..');
  const repoRoot = resolve(desktopDir, '..', '..');
  const buildDir = resolveBuildDir(env);
  assertOutsideRepo(repoRoot, buildDir);
  const stageDir = stageDirOf(buildDir);
  return { repoRoot, desktopDir, buildDir, stageDir, runtimeDir: join(stageDir, 'runtime') };
}

/** Throws unless `child` is strictly inside `parent`. Every write and delete of this script goes through it. */
export function assertInside(parent: string, child: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`recusado: ${child} fica fora de ${parent}`);
  }
}

/** The daemon's native modules are built for Node 22, and this Node is the one that gets copied as `node.exe`. */
export function assertNode22(version: string): void {
  const major = Number(version.split('.')[0]);
  if (major !== 22) {
    throw new Error(`o stage precisa rodar no Node 22 (este é o ${version}): o node.exe do runtime é uma cópia dele`);
  }
}

/**
 * `package.json` of the runtime folder: the daemon's production dependencies plus `@nanachi/shared` from the
 * copied folder (the daemon gets shared through the workspace link in the repo, so it does not declare it).
 */
export function buildRuntimePackageJson(daemonPackage: unknown): Record<string, unknown> {
  if (typeof daemonPackage !== 'object' || daemonPackage === null) throw new Error('package.json do daemon inválido');
  const { dependencies, version } = daemonPackage as { dependencies?: unknown; version?: unknown };
  if (typeof dependencies !== 'object' || dependencies === null) throw new Error('o daemon não declara dependencies');
  return {
    name: 'nanachi-runtime',
    version: typeof version === 'string' ? version : '0.0.0',
    private: true,
    description: 'Runtime staged by @nanachi/desktop. Generated; do not edit.',
    dependencies: { ...dependencies, '@nanachi/shared': 'file:packages/shared' },
  };
}

/** The PWA build to ship: the release `releases/current.json` points to, else `dist`. */
export function resolvePwaBuildDir(pwaDir: string): string {
  const pointer = join(pwaDir, 'releases', 'current.json');
  if (existsSync(pointer)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(pointer, 'utf8'));
      const release = typeof parsed === 'object' && parsed !== null ? (parsed as { release?: unknown }).release : undefined;
      if (typeof release === 'string' && /^[A-Za-z0-9._-]+$/.test(release)) {
        const dir = join(pwaDir, 'releases', release);
        if (existsSync(join(dir, 'index.html'))) return dir;
      }
    } catch {
      // An unreadable pointer falls through to dist.
    }
  }
  const dist = join(pwaDir, 'dist');
  if (existsSync(join(dist, 'index.html'))) return dist;
  throw new Error('não há build da PWA (nem releases/current.json nem dist/index.html)');
}

/**
 * npm must run under the same Node 22 that becomes `node.exe`, or `prebuild-install` fetches binaries for the wrong
 * ABI. Finds `npm-cli.js` (it is not next to this Node when Node comes from nvm) to run it with `process.execPath`.
 */
export function findNpmCli(
  env: NodeJS.ProcessEnv,
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const viaNpm = env.npm_execpath;
  const candidates: string[] = [];
  if (viaNpm !== undefined && viaNpm.endsWith('npm-cli.js')) candidates.push(viaNpm);
  candidates.push(join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const entry of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (entry !== '') candidates.push(join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

const BUILTINS: ReadonlySet<string> = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * Imports in tsc output sit at the start of a line (`import ... from 'x'`, `export ... from 'x'`, the closing
 * `} from 'x'` of a multi-line import, `import 'x'`) or are dynamic `import('x')` calls. Anchoring to the line start
 * keeps words such as `from "starting"` in a comment from counting as an import.
 */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /^[ \t]*(?:import|export)\b[^'"\n;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^[ \t]*\}\s*from\s*['"]([^'"]+)['"]/gm,
  /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
  /\bawait\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Package names imported by bare specifier in a JS source (static, side-effect and dynamic imports). */
export function bareImportsOf(source: string): string[] {
  const names = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined || specifier.startsWith('.') || specifier.startsWith('/')) continue;
      if (BUILTINS.has(specifier) || specifier.startsWith('node:')) continue;
      const parts = specifier.split('/');
      names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier));
    }
  }
  return [...names].sort();
}

function listJsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

/** Total size in bytes of every file under `dir` (links are counted as links, not followed). */
export function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else total += lstatSync(full).size;
  }
  return total;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Recursive copy by hand. `fs.cpSync` on a directory crashes Node 22.23 on Windows without any message (exit 127) when
 * the source path has a non-ASCII character, and this repository lives under "Área de Trabalho".
 */
export function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

function copyInto(stageDir: string, source: string, target: string): void {
  assertInside(stageDir, target);
  mkdirSync(dirname(target), { recursive: true });
  if (statSync(source).isDirectory()) copyTree(source, target);
  else copyFileSync(source, target);
}

function requireFile(path: string, hint: string): void {
  if (!existsSync(path)) throw new Error(`falta ${path}\n${hint}`);
}

/** Build-only files the runtime never loads: source maps, TypeScript declarations and Windows debug symbols. */
const BUILD_ONLY_SUFFIXES: readonly string[] = ['.map', '.d.ts', '.d.mts', '.d.cts', '.pdb'];

/** Extensions Node tries for a `main` or export target written without one (`''` is the path as written). */
const IMPLIED_EXTENSIONS: readonly string[] = ['', '.js', '.cjs', '.mjs', '.json', '.node'];

interface ScannedPackage {
  /** The package folder: `node_modules\<name>`, or `node_modules\@scope\<name>` for a scoped package. */
  root: string;
  /** Every regular file below `root`, except those inside a nested `node_modules`. */
  files: string[];
  /** Every package.json below `root`, the package's own included. */
  manifests: string[];
}

interface RuntimeReferences {
  /** Runtime files and folders, as {@link protectionKey} values. A folder protects everything below it. */
  paths: string[];
  /** Wildcard export targets (`./tools/*`), as regular expressions over {@link protectionKey} values. */
  patterns: RegExp[];
}

export interface PruneResult {
  removedFiles: number;
  freedBytes: number;
}

/**
 * Deletes what the runtime never loads from every package under `<runtimeDir>\node_modules`: source maps, declaration
 * files, `.pdb` debug symbols, better-sqlite3's `deps` folder (SQLite sources, build-time only) and its prebuilds for
 * other platforms (the Windows runtime loads `prebuilds\win32-x64.node` only). Nothing outside `node_modules` is touched.
 *
 * Safety rule: a file that a package.json below its package names at runtime (`main`, `module`, `bin`, or an `exports`
 * target outside a `types` condition) is kept, whatever its extension. A declaration file named only by `types` goes.
 */
export function pruneBuildOnlyFiles(runtimeDir: string): PruneResult {
  const result: PruneResult = { removedFiles: 0, freedBytes: 0 };
  const packages: ScannedPackage[] = [];
  collectPackages(join(runtimeDir, 'node_modules'), packages);
  for (const pkg of packages) {
    const name = packageNameOf(pkg.root);
    const references = runtimeReferencesOf(pkg);
    for (const file of pkg.files) {
      if (!isBuildOnly(name, relative(pkg.root, file).split(sep).join('/'))) continue;
      if (isProtected(protectionKey(file), references)) continue;
      const bytes = lstatSync(file).size;
      removeTreeOrThrow(file);
      result.removedFiles += 1;
      result.freedBytes += bytes;
    }
    if (name === 'better-sqlite3') removeEmptyDirs(join(pkg.root, 'deps'));
  }
  return result;
}

/** Every package folder under `nodeModules`, and the packages nested inside those, each with its files and manifests. */
function collectPackages(nodeModules: string, packages: ScannedPackage[]): void {
  for (const root of packageFolders(nodeModules)) {
    const pkg: ScannedPackage = { root, files: [], manifests: [] };
    const nested: string[] = [];
    scanPackage(root, pkg, nested);
    packages.push(pkg);
    for (const folder of nested) collectPackages(folder, packages);
  }
}

/** The folders directly under `nodeModules` (scoped packages are one level down). Dot folders such as `.bin` are skipped. */
function packageFolders(nodeModules: string): string[] {
  if (!existsSync(nodeModules)) return [];
  const folders: string[] = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = join(nodeModules, entry.name);
    if (!entry.name.startsWith('@')) {
      folders.push(full);
      continue;
    }
    for (const scoped of readdirSync(full, { withFileTypes: true })) {
      if (scoped.isDirectory()) folders.push(join(full, scoped.name));
    }
  }
  return folders;
}

/** Collects the files of one package. Symbolic links are not followed; a nested `node_modules` is left for later. */
function scanPackage(dir: string, pkg: ScannedPackage, nested: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') nested.push(full);
      else scanPackage(full, pkg, nested);
    } else if (entry.isFile()) {
      pkg.files.push(full);
      if (entry.name === 'package.json') pkg.manifests.push(full);
    }
  }
}

function packageNameOf(root: string): string {
  const name = basename(root);
  const parent = basename(dirname(root));
  return parent.startsWith('@') ? `${parent}/${name}` : name;
}

function isBuildOnly(packageName: string, relPath: string): boolean {
  if (BUILD_ONLY_SUFFIXES.some((suffix) => relPath.endsWith(suffix))) return true;
  if (packageName !== 'better-sqlite3') return false;
  if (relPath.startsWith('deps/')) return true;
  return /^prebuilds\/[^/]+\.node$/.test(relPath) && relPath !== 'prebuilds/win32-x64.node';
}

/** Case-folded on Windows, where `Foo.map` and `foo.map` are one file. */
function protectionKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function runtimeReferencesOf(pkg: ScannedPackage): RuntimeReferences {
  const references: RuntimeReferences = { paths: [], patterns: [] };
  for (const manifest of pkg.manifests) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      throw new Error(`package.json inválido, o stage não consegue saber o que o pacote usa: ${manifest}`);
    }
    for (const target of runtimeTargetsOf(parsed)) {
      const key = protectionKey(resolve(dirname(manifest), target));
      if (key.includes('*')) references.patterns.push(wildcardToRegExp(key));
      else references.paths.push(key);
    }
  }
  return references;
}

/** `main`, `module`, `bin` and the `exports` targets that are not under a `types` condition. */
function runtimeTargetsOf(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const { main, module: moduleField, bin, exports: exportsField } = manifest as Record<string, unknown>;
  const targets: string[] = [];
  for (const field of [main, moduleField]) {
    if (typeof field === 'string') targets.push(field);
  }
  if (typeof bin === 'string') targets.push(bin);
  else if (typeof bin === 'object' && bin !== null) {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === 'string') targets.push(value);
    }
  }
  collectExportTargets(exportsField, targets);
  return targets;
}

function collectExportTargets(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) {
    for (const item of node as unknown[]) collectExportTargets(item, out);
  } else if (typeof node === 'object' && node !== null) {
    for (const [condition, value] of Object.entries(node as Record<string, unknown>)) {
      if (condition !== 'types') collectExportTargets(value, out);
    }
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function isProtected(key: string, references: RuntimeReferences): boolean {
  const namesPath = references.paths.some(
    (path) => key.startsWith(`${path}${sep}`) || IMPLIED_EXTENSIONS.some((extension) => key === `${path}${extension}`),
  );
  return namesPath || references.patterns.some((pattern) => pattern.test(key));
}

/** Removes the folders below `dir` that are empty by now. The folder itself goes too when it ends up empty. */
function removeEmptyDirs(dir: string): void {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name));
  }
  // Empty by now, so the walker only removes this folder (it never reaches a file that could be kept).
  if (readdirSync(dir).length === 0) removeTreeOrThrow(dir);
}

export function stage(paths: StagePaths): void {
  const { repoRoot, stageDir, runtimeDir } = paths;
  assertNode22(process.versions.node);

  const shared = join(repoRoot, 'packages', 'shared');
  const daemon = join(repoRoot, 'packages', 'daemon');
  const pwa = join(repoRoot, 'packages', 'pwa');
  const buildHint = 'Este script não compila nada. Com o supervisor rodando, o build em watch já gera estes arquivos; sem ele, rode `npm run build` antes.';
  requireFile(join(shared, 'dist', 'index.js'), buildHint);
  requireFile(join(daemon, 'dist', 'main.js'), buildHint);
  requireFile(join(daemon, 'dist', 'cli.js'), buildHint);
  const pwaBuild = resolvePwaBuildDir(pwa);
  const icon = join(pwa, 'public', 'icon-192.png');
  requireFile(icon, 'ícone do app ausente');

  const npmCli = findNpmCli(process.env, process.execPath);
  if (npmCli === null) throw new Error('não achei o npm-cli.js para rodar o npm com o Node 22');

  console.log(`stage: ${runtimeDir}`);
  assertInside(stageDir, runtimeDir);
  removeTreeOrThrow(runtimeDir);
  mkdirSync(runtimeDir, { recursive: true });

  copyInto(stageDir, join(repoRoot, 'LICENSE'), join(runtimeDir, 'LICENSE'));
  copyInto(stageDir, join(repoRoot, 'README.md'), join(runtimeDir, 'README.md'));
  copyInto(stageDir, join(shared, 'package.json'), join(runtimeDir, 'packages', 'shared', 'package.json'));
  copyInto(stageDir, join(shared, 'dist'), join(runtimeDir, 'packages', 'shared', 'dist'));
  copyInto(stageDir, join(daemon, 'package.json'), join(runtimeDir, 'packages', 'daemon', 'package.json'));
  copyInto(stageDir, join(daemon, 'dist'), join(runtimeDir, 'packages', 'daemon', 'dist'));
  // The daemon puts packages/daemon/bin (the phone-send launchers) on its agents' PATH.
  copyInto(stageDir, join(daemon, 'bin'), join(runtimeDir, 'packages', 'daemon', 'bin'));
  copyInto(stageDir, pwaBuild, join(runtimeDir, 'packages', 'pwa', 'dist'));
  copyInto(stageDir, icon, join(runtimeDir, 'assets', 'icon-192.png'));
  console.log(`  pwa: ${pwaBuild}`);

  const daemonPackage: unknown = JSON.parse(readFileSync(join(daemon, 'package.json'), 'utf8'));
  writeFileSync(
    join(runtimeDir, 'package.json'),
    `${JSON.stringify(buildRuntimePackageJson(daemonPackage), null, 2)}\n`,
    'utf8',
  );

  console.log('  npm install --omit=dev --install-links --no-audit --no-fund (pode levar alguns minutos)');
  const install = spawnSync(
    process.execPath,
    [npmCli, 'install', '--omit=dev', '--install-links', '--no-audit', '--no-fund'],
    {
      cwd: runtimeDir,
      stdio: 'inherit',
      // Lifecycle scripts (prebuild-install, node-gyp) must find this Node 22 first.
      env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` },
    },
  );
  if (install.status !== 0) throw new Error(`npm install falhou (código ${install.status ?? 'sem código'})`);

  copyFileSync(process.execPath, join(runtimeDir, 'node.exe'));

  // After the install, before the check: the check below proves the daemon still starts without what was removed.
  const pruned = pruneBuildOnlyFiles(runtimeDir);
  console.log(`  poda: ${pruned.removedFiles} arquivos de build removidos, ${megabytes(pruned.freedBytes)} liberados`);

  verifyRuntime(runtimeDir);

  const bytes = directorySize(runtimeDir);
  console.log(`stage pronto: ${megabytes(bytes)} em ${runtimeDir}`);
  for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
    const full = join(runtimeDir, entry.name);
    console.log(`  ${entry.name.padEnd(18)} ${entry.isDirectory() ? megabytes(directorySize(full)) : megabytes(lstatSync(full).size)}`);
  }
}

/** Checks that what was installed is enough for the daemon, using the staged `node.exe` itself. */
function verifyRuntime(runtimeDir: string): void {
  const nodeModules = join(runtimeDir, 'node_modules');
  const missing = new Set<string>();
  for (const file of listJsFiles(join(runtimeDir, 'packages', 'daemon', 'dist'))) {
    for (const name of bareImportsOf(readFileSync(file, 'utf8'))) {
      if (!existsSync(join(nodeModules, name))) missing.add(name);
    }
  }
  if (missing.size > 0) {
    throw new Error(`o daemon importa pacotes que o stage não instalou: ${[...missing].join(', ')}`);
  }

  // The native modules must load under the staged Node (ABI check), from the staged tree.
  const probe = spawnSync(
    join(runtimeDir, 'node.exe'),
    [
      '-e',
      "const D = require('better-sqlite3'); new D(':memory:').close(); require('@lydell/node-pty'); console.log('native modules ok')",
    ],
    { cwd: join(runtimeDir, 'packages', 'daemon'), encoding: 'utf8', windowsHide: true },
  );
  if (probe.status !== 0) {
    throw new Error(`módulos nativos não carregam no node.exe do runtime:\n${probe.stderr || probe.stdout}`);
  }
  console.log(`  ${probe.stdout.trim()}`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  try {
    stage(stagePaths(import.meta.url));
  } catch (error) {
    console.error(`stage: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
