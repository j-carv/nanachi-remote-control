import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRotatingLog } from '../src/supervisor-log.js';
import { removeTempDir } from './temp.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-slog-'));
});

afterEach(async () => {
  await removeTempDir(dir);
});

describe('createRotatingLog', () => {
  it('prefixa cada linha com horário e origem, e separa linhas de um mesmo texto', async () => {
    const file = join(dir, 'supervisor.log');
    const log = createRotatingLog({ file, maxBytes: 1_000_000, clock: () => new Date('2026-11-03T12:00:00.000Z') });

    log.write('daemon', 'primeira\nsegunda\r\n');

    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines).toEqual([
      '2026-11-03T12:00:00.000Z [daemon] primeira',
      '2026-11-03T12:00:00.000Z [daemon] segunda',
    ]);
  });

  it('ao passar do limite, renomeia para .1 e começa um arquivo novo; mantém só um antigo', async () => {
    const file = join(dir, 'supervisor.log');
    const log = createRotatingLog({ file, maxBytes: 300 });

    for (let i = 0; i < 20; i += 1) log.write('x', `linha ${i} ${'.'.repeat(30)}`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect((await readFile(file, 'utf8')).length).toBeLessThanOrEqual(300);

    const firstRotated = await readFile(`${file}.1`, 'utf8');
    for (let i = 20; i < 60; i += 1) log.write('x', `linha ${i} ${'.'.repeat(30)}`);

    expect(await readFile(`${file}.1`, 'utf8')).not.toBe(firstRotated);
    expect(existsSync(`${file}.2`)).toBe(false);
  });

  it('retoma o tamanho de um arquivo que já existia antes de abrir', async () => {
    const file = join(dir, 'supervisor.log');
    await writeFile(file, 'x'.repeat(290));
    const log = createRotatingLog({ file, maxBytes: 300 });

    log.write('a', 'mais um pouco de texto aqui');

    expect(existsSync(`${file}.1`)).toBe(true);
  });

  it('repassa cada linha ao echo (console) quando ele é dado', () => {
    const echoed: string[] = [];
    const log = createRotatingLog({
      file: join(dir, 'supervisor.log'),
      maxBytes: 1_000_000,
      echo: (line) => echoed.push(line),
      clock: () => new Date('2026-11-03T12:00:00.000Z'),
    });

    log.write('supervisor', 'iniciado');

    expect(echoed).toEqual(['2026-11-03T12:00:00.000Z [supervisor] iniciado']);
  });
});
