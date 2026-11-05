import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPayload, listEntries } from '../scripts/payload-zip.js';
import { extractPayload } from '../src/install/extract.js';
import { parsePayloadMeta, readPayload } from '../src/install/payload.js';
import { removeDir } from './remove-dir.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nanachi-payload-test-'));
});
afterEach(() => {
  removeDir(root);
});

function makeApp(dir: string): void {
  const files: Record<string, string> = {
    'Nanachi.exe': 'MZ exe',
    'resources/app.asar': 'asar',
    'resources/runtime/node.exe': 'node',
    'resources/runtime/node_modules/pacote/ação.js': 'unicode name',
    'locales/pt-BR.pak': 'pak',
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, ...name.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  mkdirSync(join(dir, 'resources', 'empty-folder'), { recursive: true });
}

function snapshot(dir: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  function walk(current: string): void {
    const children = readdirSync(current, { withFileTypes: true });
    if (children.length === 0) result[`${relative(dir, current).replaceAll('\\', '/')}/`] = null;
    for (const child of children) {
      const full = join(current, child.name);
      if (child.isDirectory()) walk(full);
      else result[relative(dir, full).replaceAll('\\', '/')] = readFileSync(full, 'utf8');
    }
  }
  walk(dir);
  return result;
}

describe('listEntries', () => {
  it('lists files with forward-slash names, in a stable order, and empty folders', () => {
    const app = join(root, 'app');
    makeApp(app);
    const entries = listEntries(app).map((entry) => `${entry.name}${entry.directory ? '/' : ''}`);
    expect(listEntries(app).map((entry) => `${entry.name}${entry.directory ? '/' : ''}`)).toEqual(entries);
    expect(entries[0]).toBe('Nanachi.exe');
    expect(entries).toContain('resources/runtime/node_modules/pacote/ação.js');
    expect(entries).toContain('resources/empty-folder/');
    expect(entries.every((name) => !name.includes('\\'))).toBe(true);
  });
});

describe('createPayload', () => {
  it('zips an app folder and the installer extracts the same tree, accents and empty folders included', async () => {
    const app = join(root, 'win-unpacked');
    makeApp(app);
    const out = join(root, 'payload');
    const result = await createPayload(app, out, '3.1.4');

    expect(result.meta).toEqual({ schema: 1, version: '3.1.4', exe: 'Nanachi.exe', files: 5, uncompressedBytes: 6 + 4 + 4 + 12 + 3 });
    expect(statSync(result.zipPath).size).toBeGreaterThan(0);
    expect(existsSync(`${result.zipPath}.part`)).toBe(false);
    expect(readPayload(out).meta).toEqual(result.meta);
    expect(parsePayloadMeta(JSON.parse(readFileSync(result.metaPath, 'utf8')))).toEqual(result.meta);

    const target = join(root, 'installed');
    let last = 0;
    await extractPayload(result.zipPath, target, (done) => {
      expect(done).toBeGreaterThanOrEqual(last);
      last = done;
    });
    expect(snapshot(target)).toEqual(snapshot(app));
    expect(last).toBeGreaterThan(0);
  });

  it('refuses a folder without Nanachi.exe or without files', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    await expect(createPayload(empty, join(root, 'o1'), '1.0.0')).rejects.toThrow(/nada para empacotar/);
    const noExe = join(root, 'no-exe');
    mkdirSync(noExe);
    writeFileSync(join(noExe, 'other.txt'), 'x');
    await expect(createPayload(noExe, join(root, 'o2'), '1.0.0')).rejects.toThrow(/Nanachi\.exe/);
  });

  it('replaces an earlier payload in the same folder', async () => {
    const app = join(root, 'app');
    makeApp(app);
    const out = join(root, 'payload');
    await createPayload(app, out, '1.0.0');
    writeFileSync(join(app, 'extra.txt'), 'new');
    const second = await createPayload(app, out, '1.0.1');
    expect(readPayload(out).meta).toMatchObject({ version: '1.0.1', files: 6 });
    expect(second.meta.files).toBe(6);
  });
});
