import { mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { swapDirectory, type RenameFn } from './atomic-output.js';

/** Erro de sistema de arquivos com código (EBUSY, EPERM...), como o Node lança no Windows. */
function fsError(code: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: arquivo em uso`), { code });
}

let base: string;
let target: string;
let staging: string;
let backup: string;

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content);
  }
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else out[rel] = await readFile(join(current, entry.name), 'utf8');
    }
  }
  await walk(dir, '');
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

/** Troca sem espera entre as tentativas (os testes não precisam dormir). */
function options(rename?: RenameFn) {
  return {
    target,
    staging,
    attempts: 3,
    retryDelayMs: 0,
    ...(rename === undefined ? {} : { rename }),
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nanachi-swap-'));
  target = join(base, 'dist');
  staging = join(base, 'dist-next');
  backup = join(base, 'dist-old');
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('swapDirectory', () => {
  it('troca dist pelo conteúdo de dist-next e não deixa pastas intermediárias', async () => {
    await writeTree(target, { 'index.html': 'antigo', 'assets/a.js': 'a' });
    await writeTree(staging, { 'index.html': 'novo', 'assets/b.js': 'b' });

    await swapDirectory(options());

    expect(await readTree(target)).toEqual({ 'index.html': 'novo', 'assets/b.js': 'b' });
    expect(await exists(staging)).toBe(false);
    expect(await exists(backup)).toBe(false);
  });

  it('sem dist anterior (primeiro build), só move dist-next para dist', async () => {
    await writeTree(staging, { 'index.html': 'novo' });

    await swapDirectory(options());

    expect(await readTree(target)).toEqual({ 'index.html': 'novo' });
    expect(await exists(staging)).toBe(false);
  });

  it('repete o rename do dist antigo quando o Windows devolve EBUSY, e segue', async () => {
    await writeTree(target, { 'index.html': 'antigo' });
    await writeTree(staging, { 'index.html': 'novo' });
    let oldRenames = 0;
    const rename: RenameFn = async (from, to) => {
      if (from === target) {
        oldRenames += 1;
        if (oldRenames <= 2) throw fsError('EBUSY');
      }
      await fsRename(from, to);
    };

    await swapDirectory(options(rename));

    expect(oldRenames).toBe(3);
    expect(await readTree(target)).toEqual({ 'index.html': 'novo' });
  });

  it('repete o rename do dist-next quando há EPERM passageiro, e segue', async () => {
    await writeTree(target, { 'index.html': 'antigo' });
    await writeTree(staging, { 'index.html': 'novo' });
    let newRenames = 0;
    const rename: RenameFn = async (from, to) => {
      if (from === staging) {
        newRenames += 1;
        if (newRenames === 1) throw fsError('EPERM');
      }
      await fsRename(from, to);
    };

    await swapDirectory(options(rename));

    expect(newRenames).toBe(2);
    expect(await readTree(target)).toEqual({ 'index.html': 'novo' });
  });

  it('dist antigo sempre em uso: lança sem tocar em nada (dist e dist-next intactos)', async () => {
    await writeTree(target, { 'index.html': 'antigo' });
    await writeTree(staging, { 'index.html': 'novo' });
    const rename: RenameFn = async (from) => {
      if (from === target) throw fsError('EPERM');
    };

    await expect(swapDirectory(options(rename))).rejects.toThrow(/EPERM/);

    expect(await readTree(target)).toEqual({ 'index.html': 'antigo' });
    expect(await readTree(staging)).toEqual({ 'index.html': 'novo' });
    expect(await exists(backup)).toBe(false);
  });

  it('falha ao mover dist-next para dist: restaura o dist antigo e mantém dist-next', async () => {
    await writeTree(target, { 'index.html': 'antigo' });
    await writeTree(staging, { 'index.html': 'novo' });
    const rename: RenameFn = async (from, to) => {
      if (from === staging) throw fsError('EINVAL');
      await fsRename(from, to);
    };

    await expect(swapDirectory(options(rename))).rejects.toThrow(/EINVAL/);

    expect(await readTree(target)).toEqual({ 'index.html': 'antigo' });
    expect(await readTree(staging)).toEqual({ 'index.html': 'novo' });
    expect(await exists(backup)).toBe(false);
  });

  it('falha simulada no meio (EPERM sem fim ao mover dist-next): dist antigo volta inteiro', async () => {
    await writeTree(target, { 'index.html': 'antigo', 'assets/a.js': 'a' });
    await writeTree(staging, { 'index.html': 'novo', 'assets/b.js': 'b' });
    const rename: RenameFn = async (from, to) => {
      if (from === staging) throw fsError('EPERM');
      await fsRename(from, to);
    };

    await expect(swapDirectory(options(rename))).rejects.toThrow(/EPERM/);

    expect(await readTree(target)).toEqual({ 'index.html': 'antigo', 'assets/a.js': 'a' });
    expect(await readTree(staging)).toEqual({ 'index.html': 'novo', 'assets/b.js': 'b' });
  });

  it('dist-next ausente: lança e não toca no dist', async () => {
    await writeTree(target, { 'index.html': 'antigo' });

    await expect(swapDirectory(options())).rejects.toThrow(/dist-next/);

    expect(await readTree(target)).toEqual({ 'index.html': 'antigo' });
  });

  it('restaura o dist de uma troca interrompida (dist ausente, dist-old presente) antes de trocar', async () => {
    await writeTree(backup, { 'index.html': 'antigo' });
    await writeTree(staging, { 'index.html': 'novo' });

    await swapDirectory(options());

    expect(await readTree(target)).toEqual({ 'index.html': 'novo' });
    expect(await exists(backup)).toBe(false);
  });

  it('apaga dist-old que sobrou de uma troca anterior', async () => {
    await writeTree(target, { 'index.html': 'atual' });
    await writeTree(backup, { 'lixo.js': 'x' });
    await writeTree(staging, { 'index.html': 'novo' });

    await swapDirectory(options());

    expect(await readTree(target)).toEqual({ 'index.html': 'novo' });
    expect(await exists(backup)).toBe(false);
  });
});
