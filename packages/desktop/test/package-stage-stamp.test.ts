import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprintStageInputs, isStageFresh, readStageStamp, stageInputFiles, writeStageStamp } from '../scripts/stage-stamp.js';
import { removeDir } from './remove-dir.js';

let root: string;
let stageDir: string;
let runtimeDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nanachi-stamp-test-'));
  // A miniature repository: what stage.ts copies from.
  const files: Record<string, string> = {
    'packages/shared/package.json': '{}',
    'packages/shared/dist/index.js': 'shared',
    'packages/daemon/package.json': '{}',
    'packages/daemon/dist/main.js': 'daemon',
    'packages/daemon/dist/cli.js': 'cli',
    'packages/daemon/bin/phone-send.cmd': 'x',
    'packages/pwa/dist/index.html': '<html>',
    'packages/pwa/public/icon-192.png': 'png',
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, ...name.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  stageDir = join(root, 'build', 'stage');
  runtimeDir = join(stageDir, 'runtime');
  mkdirSync(join(runtimeDir, 'node_modules'), { recursive: true });
  mkdirSync(join(runtimeDir, 'packages', 'daemon', 'dist'), { recursive: true });
  writeFileSync(join(runtimeDir, 'node.exe'), 'node');
  writeFileSync(join(runtimeDir, 'packages', 'daemon', 'dist', 'main.js'), 'daemon');
});
afterEach(() => {
  removeDir(root);
});

describe('stage fingerprint', () => {
  it('lists what the stage copies from the repository, PWA build and icon included', () => {
    const names = stageInputFiles({ repoRoot: root }).map((path) => path.slice(root.length + 1).replaceAll('\\', '/'));
    expect(names).toEqual(
      [
        'packages/daemon/bin/phone-send.cmd',
        'packages/daemon/dist/cli.js',
        'packages/daemon/dist/main.js',
        'packages/daemon/package.json',
        'packages/pwa/dist/index.html',
        'packages/pwa/public/icon-192.png',
        'packages/shared/dist/index.js',
        'packages/shared/package.json',
      ].sort(),
    );
  });

  it('is stable while nothing changes and changes with a file, a size, an mtime or the Node version', () => {
    const base = fingerprintStageInputs({ repoRoot: root }, 'v22.1.0');
    expect(fingerprintStageInputs({ repoRoot: root }, 'v22.1.0')).toBe(base);
    expect(fingerprintStageInputs({ repoRoot: root }, 'v22.2.0')).not.toBe(base);

    const main = join(root, 'packages', 'daemon', 'dist', 'main.js');
    const later = new Date(Date.now() + 60_000);
    utimesSync(main, later, later);
    const touched = fingerprintStageInputs({ repoRoot: root }, 'v22.1.0');
    expect(touched).not.toBe(base);

    writeFileSync(main, 'a longer daemon build');
    expect(fingerprintStageInputs({ repoRoot: root }, 'v22.1.0')).not.toBe(touched);

    writeFileSync(join(root, 'packages', 'pwa', 'dist', 'new-chunk.js'), 'x');
    expect(stageInputFiles({ repoRoot: root }).some((path) => path.endsWith('new-chunk.js'))).toBe(true);
  });
});

describe('isStageFresh', () => {
  const paths = () => ({ stageDir, runtimeDir });

  it('is fresh only with the runtime on disk and a stamp that matches', () => {
    const fingerprint = fingerprintStageInputs({ repoRoot: root });
    expect(isStageFresh(paths(), fingerprint)).toBe(false); // no stamp yet (a stage from before stamps existed)
    writeStageStamp(stageDir, fingerprint, new Date('2026-11-05T00:00:00Z'));
    expect(readStageStamp(stageDir)).toEqual({ fingerprint, stagedAt: '2026-11-05T00:00:00.000Z' });
    expect(isStageFresh(paths(), fingerprint)).toBe(true);
    expect(isStageFresh(paths(), 'a different fingerprint')).toBe(false);
  });

  it('is stale when a piece of the runtime is missing, whatever the stamp says', () => {
    const fingerprint = fingerprintStageInputs({ repoRoot: root });
    writeStageStamp(stageDir, fingerprint);
    rmSync(join(runtimeDir, 'node.exe'));
    expect(isStageFresh(paths(), fingerprint)).toBe(false);
  });

  it('treats a broken stamp as no stamp', () => {
    writeFileSync(join(stageDir, 'stage-stamp.json'), '{not json');
    expect(readStageStamp(stageDir)).toBeNull();
    writeFileSync(join(stageDir, 'stage-stamp.json'), '{"fingerprint":1}');
    expect(readStageStamp(stageDir)).toBeNull();
  });
});
