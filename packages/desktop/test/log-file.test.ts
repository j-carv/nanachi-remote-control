import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRotatingLog, readDesktopLogs } from '../src/main/log-file.js';
import { removeDir } from './remove-dir.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanachi-desktop-log-'));
});
afterEach(() => {
  removeDir(dir);
});

describe('rotating log', () => {
  it('appends text to the file, creating the folder when needed', () => {
    const file = join(dir, 'nested', 'desktop-daemon.log');
    const log = createRotatingLog({ file, maxBytes: 1000 });
    log.append('one\n');
    log.append('two\n');
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n');
  });

  it('rotates to a single backup once the file reaches the limit', () => {
    const file = join(dir, 'daemon.log');
    const log = createRotatingLog({ file, maxBytes: 20 });
    log.append('a'.repeat(20));
    log.append('second\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('a'.repeat(20));
    expect(readFileSync(file, 'utf8')).toBe('second\n');

    log.append('b'.repeat(30));
    log.append('third\n');
    // The old backup is replaced; only one backup ever exists.
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('second\n' + 'b'.repeat(30));
    expect(existsSync(`${file}.2`)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('third\n');
  });

  it('rotates a file left over from a previous run before appending', () => {
    const file = join(dir, 'daemon.log');
    writeFileSync(file, 'x'.repeat(50));
    const log = createRotatingLog({ file, maxBytes: 40 });
    log.append('fresh\n');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(50));
    expect(readFileSync(file, 'utf8')).toBe('fresh\n');
  });

  it('tail returns the last non-empty lines, and nothing when the file does not exist', () => {
    const file = join(dir, 'daemon.log');
    const log = createRotatingLog({ file, maxBytes: 10_000 });
    expect(log.tail(5)).toEqual([]);
    log.append('l1\nl2\n\nl3\r\nl4\n');
    expect(log.tail(2)).toEqual(['l3', 'l4']);
    expect(log.tail(10)).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  it('never throws when the log cannot be written', () => {
    // A path whose parent is a file: mkdir and append both fail.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'file');
    const log = createRotatingLog({ file: join(blocker, 'sub', 'daemon.log'), maxBytes: 100 });
    expect(() => log.append('lost\n')).not.toThrow();
    expect(log.tail(3)).toEqual([]);
  });
});

describe('readDesktopLogs', () => {
  it('gives two empty lists when the file does not exist yet', () => {
    expect(readDesktopLogs(join(dir, 'nada.log'))).toEqual({ daemon: [], tailscale: [] });
  });

  it('splits the [tsnet] lines from the rest, keeping each list in order', () => {
    const file = join(dir, 'desktop-daemon.log');
    writeFileSync(
      file,
      [
        '[desktop] bandeja criada',
        '{"level":30,"msg":"listening"}',
        '[tsnet] iniciado (pid 10, nó nanachi-pc)',
        '[desktop] daemon running (porta 7780)',
        '[tsnet] rodando em https://nanachi-pc.tail1234.ts.net',
        '',
      ].join('\n'),
    );
    expect(readDesktopLogs(file)).toEqual({
      daemon: ['[desktop] bandeja criada', '{"level":30,"msg":"listening"}', '[desktop] daemon running (porta 7780)'],
      tailscale: ['[tsnet] iniciado (pid 10, nó nanachi-pc)', '[tsnet] rodando em https://nanachi-pc.tail1234.ts.net'],
    });
  });

  it('keeps at most the last maxLines of each list (500 by default)', () => {
    const file = join(dir, 'desktop-daemon.log');
    const lines: string[] = [];
    for (let index = 0; index < 1400; index += 1) lines.push(index % 2 === 0 ? `daemon ${index}` : `[tsnet] linha ${index}`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    const logs = readDesktopLogs(file);
    expect(logs.daemon).toHaveLength(500);
    expect(logs.tailscale).toHaveLength(500);
    expect(logs.daemon.at(-1)).toBe('daemon 1398');
    expect(logs.tailscale.at(-1)).toBe('[tsnet] linha 1399');

    const few = readDesktopLogs(file, { maxLines: 3 });
    expect(few.daemon).toEqual(['daemon 1394', 'daemon 1396', 'daemon 1398']);
    expect(few.tailscale).toEqual(['[tsnet] linha 1395', '[tsnet] linha 1397', '[tsnet] linha 1399']);
  });

  it('reads only the end of a big file and drops the line the window cut in half', () => {
    const file = join(dir, 'desktop-daemon.log');
    const tail = 'linha inteira A\nlinha inteira B\n';
    writeFileSync(file, `${'x'.repeat(5000)}\n${tail}`);
    expect(readDesktopLogs(file, { windowBytes: tail.length + 8 }).daemon).toEqual(['linha inteira A', 'linha inteira B']);
    // A window that starts exactly on a line boundary keeps that line.
    expect(readDesktopLogs(file, { windowBytes: tail.length }).daemon).toEqual(['linha inteira A', 'linha inteira B']);
    // One byte less cuts the first line.
    expect(readDesktopLogs(file, { windowBytes: tail.length - 1 }).daemon).toEqual(['linha inteira B']);
  });

  it('keeps the first line when the window covers the whole file', () => {
    const file = join(dir, 'desktop-daemon.log');
    writeFileSync(file, 'primeira\nsegunda\n');
    expect(readDesktopLogs(file).daemon).toEqual(['primeira', 'segunda']);
  });

  it('reads accents and CRLF line ends, and strips terminal escape codes and control characters', () => {
    const file = join(dir, 'desktop-daemon.log');
    writeFileSync(file, '[desktop] pareamento concluído\r\n\u001b[31mErro em vermelho\u001b[0m\r\ncom\u0007 sino\r\n');
    expect(readDesktopLogs(file).daemon).toEqual(['[desktop] pareamento concluído', 'Erro em vermelho', 'com sino']);
  });

  it('cuts a very long line so the panel stays usable', () => {
    const file = join(dir, 'desktop-daemon.log');
    writeFileSync(file, `${'a'.repeat(5000)}\n`);
    const [line] = readDesktopLogs(file).daemon;
    expect(line?.length).toBeLessThan(2100);
    expect(line?.endsWith('...')).toBe(true);
  });
});
