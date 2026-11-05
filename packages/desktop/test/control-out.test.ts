import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILD_MARKER, markControlBuild, prepareControlOut } from '../scripts/control-out.js';
import { removeDir } from './remove-dir.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'nanachi-control-out-'));
});
afterEach(() => {
  removeDir(base);
});

describe('prepareControlOut', () => {
  it('a folder that does not exist yet is fine, with or without an explicit path', () => {
    for (const explicit of [true, false]) {
      const out = join(base, `novo-${explicit}`);
      prepareControlOut(out, { explicit });
      expect(readdirSync(out)).toEqual([]);
    }
  });

  it('an empty folder is fine', () => {
    const out = join(base, 'vazia');
    mkdirSync(out);
    expect(() => prepareControlOut(out, { explicit: true })).not.toThrow();
  });

  it('empties the output of a previous build (it carries the marker)', () => {
    const out = join(base, 'anterior');
    mkdirSync(join(out, 'assets'), { recursive: true });
    writeFileSync(join(out, 'index.html'), '<html></html>');
    writeFileSync(join(out, 'assets', 'app.js'), '1');
    markControlBuild(out);
    prepareControlOut(out, { explicit: true });
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses to delete a non-empty folder that was not made by this build, and leaves it alone', () => {
    const out = join(base, 'documentos');
    mkdirSync(out);
    writeFileSync(join(out, 'tese.docx'), 'meu trabalho');
    expect(() => prepareControlOut(out, { explicit: true })).toThrow(/NANACHI_CONTROL_OUT/);
    expect(existsSync(join(out, 'tese.docx'))).toBe(true);
  });

  it('refuses a path that is a file', () => {
    const out = join(base, 'arquivo.txt');
    writeFileSync(out, 'x');
    expect(() => prepareControlOut(out, { explicit: true })).toThrow(/NANACHI_CONTROL_OUT/);
    expect(existsSync(out)).toBe(true);
  });

  it('the repository\'s own dist/control (no explicit path) is always this build\'s, marked or not (the first build after an upgrade)', () => {
    const out = join(base, 'dist-control');
    mkdirSync(out);
    writeFileSync(join(out, 'index.html'), '<html></html>');
    prepareControlOut(out, { explicit: false });
    expect(readdirSync(out)).toEqual([]);
  });

  it('marks a finished build so the next run may replace it', () => {
    const out = join(base, 'saida');
    prepareControlOut(out, { explicit: true });
    writeFileSync(join(out, 'index.html'), 'x');
    markControlBuild(out);
    expect(existsSync(join(out, BUILD_MARKER))).toBe(true);
    expect(() => prepareControlOut(out, { explicit: true })).not.toThrow();
    expect(readdirSync(out)).toEqual([]);
  });
});
