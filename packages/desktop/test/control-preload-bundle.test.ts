import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPreloads } from '../scripts/preload-build.js';
import { removeDir } from './remove-dir.js';

/** The real build function of `npm run build:desktop`, into a temporary folder: what is checked is what ships. */
let outdir: string;
let control: string;
let panel: string;

beforeAll(async () => {
  outdir = mkdtempSync(join(tmpdir(), 'nanachi-preload-'));
  const result = await buildPreloads({ outdir });
  expect(result.errors).toEqual([]);
  control = readFileSync(join(outdir, 'control.cjs'), 'utf8');
  panel = readFileSync(join(outdir, 'index.cjs'), 'utf8');
}, 60_000);

afterAll(() => {
  removeDir(outdir);
});

describe('preload bundles', () => {
  it('the build writes both preloads next to each other, as CommonJS files', () => {
    expect(readdirSync(outdir).sort()).toEqual(['control.cjs', 'index.cjs']);
  });

  it('the control preload carries only control channels, and the panel preload only its own', () => {
    expect(control).toContain('control:overview');
    expect(control).not.toContain('desktop:');
    expect(control).toContain('nanachiControl');
    expect(control).not.toContain('nanachiDesktop');

    expect(panel).toContain('desktop:status');
    expect(panel).not.toContain('control:');
    expect(panel).toContain('nanachiDesktop');
    expect(panel).not.toContain('nanachiControl');
  });

  it('a sandboxed preload can only require electron', () => {
    for (const [name, text] of [
      ['control.cjs', control],
      ['index.cjs', panel],
    ] as const) {
      const required = [...text.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
      expect(new Set(required), name).toEqual(new Set(['electron']));
    }
  });

  it('the control preload exposes nothing but nanachiControl', () => {
    expect([...control.matchAll(/exposeInMainWorld\("([^"]+)"/g)].map((match) => match[1])).toEqual(['nanachiControl']);
  });
});
