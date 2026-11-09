import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resolvePwaBuildDir, type StagePaths } from './stage.js';

/**
 * Is the stage folder still what the repository's build outputs would produce? `npm run package` restages only when
 * not (or with `--fresh`): the stage is ~1 GB and an `npm install` away from minutes of work.
 *
 * The fingerprint is a hash of the path, size and mtime of every file the stage copies from the repository (the shared
 * and daemon builds, the PWA build the supervisor published, the icon), of the stage script itself (its rules decide
 * what the stage keeps, so a changed script must restage), plus the Node version whose `node.exe` is copied.
 * It is written next to the stage after a successful stage run.
 */

const STAMP = 'stage-stamp.json';

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

export function stageInputFiles(paths: Pick<StagePaths, 'repoRoot'>): string[] {
  const shared = join(paths.repoRoot, 'packages', 'shared');
  const daemon = join(paths.repoRoot, 'packages', 'daemon');
  const pwa = join(paths.repoRoot, 'packages', 'pwa');
  const files = [
    join(paths.repoRoot, 'LICENSE'),
    join(paths.repoRoot, 'README.md'),
    join(shared, 'package.json'),
    ...listFiles(join(shared, 'dist')),
    join(daemon, 'package.json'),
    ...listFiles(join(daemon, 'dist')),
    ...(existsSync(join(daemon, 'bin')) ? listFiles(join(daemon, 'bin')) : []),
    ...listFiles(resolvePwaBuildDir(pwa)),
    join(pwa, 'public', 'icon-192.png'),
    join(paths.repoRoot, 'packages', 'desktop', 'scripts', 'stage.ts'),
  ];
  return files.sort();
}

export function fingerprintStageInputs(paths: Pick<StagePaths, 'repoRoot'>, nodeVersion: string = process.version): string {
  const hash = createHash('sha256');
  hash.update(`node ${nodeVersion}\n`);
  for (const file of stageInputFiles(paths)) {
    const stats = statSync(file);
    hash.update(`${relative(paths.repoRoot, file)}|${stats.size}|${Math.round(stats.mtimeMs)}\n`);
  }
  return hash.digest('hex');
}

interface StageStamp {
  fingerprint: string;
  stagedAt: string;
}

export function writeStageStamp(stageDir: string, fingerprint: string, now: Date = new Date()): void {
  const stamp: StageStamp = { fingerprint, stagedAt: now.toISOString() };
  writeFileSync(join(stageDir, STAMP), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}

export function readStageStamp(stageDir: string): StageStamp | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stageDir, STAMP), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const { fingerprint, stagedAt } = raw as Record<string, unknown>;
    return typeof fingerprint === 'string' && typeof stagedAt === 'string' ? { fingerprint, stagedAt } : null;
  } catch {
    return null;
  }
}

/** The stage folder has what the daemon needs and was made from inputs with this fingerprint. */
export function isStageFresh(paths: Pick<StagePaths, 'stageDir' | 'runtimeDir'>, fingerprint: string): boolean {
  const needed = [
    join(paths.runtimeDir, 'node.exe'),
    join(paths.runtimeDir, 'packages', 'daemon', 'dist', 'main.js'),
    join(paths.runtimeDir, 'node_modules'),
  ];
  if (!needed.every((path) => existsSync(path))) return false;
  return readStageStamp(paths.stageDir)?.fingerprint === fingerprint;
}
