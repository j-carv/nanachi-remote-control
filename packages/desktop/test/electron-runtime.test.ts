import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { removeTree } from '../src/install/safe-remove.js';

/**
 * The folder removal under ELECTRON'S OWN NODE. vitest runs on Node 22, where `fs.rmSync(path, { recursive: true })` does
 * not follow directory junctions; the packaged app runs on Electron 45 (Node 24), where it does, and deletes what the
 * junction points to. A test on Node 22 cannot see that, so these run the real code in `electron.exe` with
 * `ELECTRON_RUN_AS_NODE=1` (the repository's copy; the fuse that turns this off is only flipped in the packaged app).
 */

// Starting electron.exe (and bundling) is slow on a busy machine: the default 10 s is for pure unit tests.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronExe = ((): string | null => {
  try {
    const resolved: unknown = require('electron');
    return typeof resolved === 'string' && existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
})();
const probe = join(here, 'fixtures', 'electron-probe.cjs');
const entry = join(here, 'fixtures', 'electron-probe-entry.ts');

interface Facts {
  runtime: { node: string; electron: string | null };
  scenario: string;
  error?: string;
  [key: string]: unknown;
}

let outDir: string;
let bundle: string;
const workDirs: string[] = [];

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'nanachi-electron-bundle-'));
  bundle = join(outDir, 'probe-bundle.cjs');
  buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: bundle, logLevel: 'warning' });
});

afterAll(() => {
  removeTree(outDir, nodeFs);
});

afterEach(() => {
  for (const dir of workDirs.splice(0)) removeTree(dir, nodeFs);
});

function runScenario(scenario: string): Facts {
  if (electronExe === null) throw new Error('electron.exe not found');
  const work = mkdtempSync(join(tmpdir(), 'nanachi-electron-work-'));
  workDirs.push(work);
  const result = spawnSync(electronExe, [probe, bundle, scenario, work], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const last = result.stdout.trim().split(/\r?\n/).at(-1) ?? '';
  let facts: Facts;
  try {
    facts = JSON.parse(last) as Facts;
  } catch {
    throw new Error(`probe printed no JSON (status ${result.status}): ${result.stdout}\n${result.stderr}`);
  }
  if (facts.error !== undefined) throw new Error(`probe failed: ${facts.error}`);
  return facts;
}

describe.skipIf(process.platform !== 'win32' || electronExe === null)('folder removal under Electron\'s Node', () => {
  it('runs in Electron, not in the Node of vitest', () => {
    const facts = runScenario('canary');
    expect(facts.runtime.electron).toMatch(/^\d+\./);
    expect(Number(facts.runtime.node.split('.')[0])).toBeGreaterThanOrEqual(24);
    // Informational: the reason the walker exists. If a future Electron stops following junctions, this test says so
    // instead of silently becoming as blind as a Node 22 run.
    if (facts.plainRmSyncFollowsJunction !== true) {
      console.warn('the plain recursive delete no longer follows junctions in this Electron: the junction tests below prove less now');
    }
  });

  it('removeTree deletes a tree with junctions inside it and leaves what they point to', () => {
    const facts = runScenario('tree-with-junctions');
    expect(facts.removed).toBe(true);
    expect(facts.treeExists).toBe(false);
    expect(facts.outsideKeep).toBe(true);
    expect(facts.outsideDeep).toBe(true);
  });

  it('removeTree on a junction at the top level removes the link only', () => {
    const facts = runScenario('top-level-junction');
    expect(facts.removed).toBe(true);
    expect(facts.junctionExists).toBe(false);
    expect(facts.outsideKeep).toBe(true);
    expect(facts.outsideDeep).toBe(true);
  });

  it('"Apagar também os dados" with junctions into ~/.claude and ~/.codex inside NANACHI_HOME keeps the agents\' history', () => {
    const facts = runScenario('delete-data');
    expect(facts.warnings).toEqual([]);
    expect(facts.homeExists).toBe(false);
    expect(facts.installExists).toBe(false);
    expect(facts.desktopDataExists).toBe(false);
    expect(facts.claudeProjects).toBe(true);
    expect(facts.claudeSkills).toBe(true);
    expect(facts.codexSessions).toBe(true);
  });

  it('an upgrade over an install that has junctions replaces the files, keeps the targets and ends with a complete marker', () => {
    const facts = runScenario('upgrade');
    expect(facts.installedExe).toBe(true);
    expect(facts.oldFileGone).toBe(true);
    expect(facts.linksGone).toBe(true);
    expect(facts.outsideKeep).toBe(true);
    expect(facts.outsideDeep).toBe(true);
    expect(facts.marker).toMatchObject({ version: '1.0.0', complete: true });
  });
});
