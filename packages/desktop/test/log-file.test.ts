import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRotatingLog } from '../src/main/log-file.js';
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
