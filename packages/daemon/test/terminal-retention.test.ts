import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { dropOldestTerminalOutput, insertEvent, listEvents } from '../src/repository.js';
import { removeTempDir } from './temp.js';

let dir: string;
let db: Database.Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-retention-'));
  db = openDatabase(join(dir, 'data.db'));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

/** Grava um terminal_output com `size` bytes de dados (ASCII: 1 byte por caractere). */
function output(sessionId: string, size: number): number {
  return insertEvent(db, {
    sessionId,
    ts: 1,
    kind: 'terminal_output',
    payload: JSON.stringify({ kind: 'terminal_output', data: 'x'.repeat(size) }),
  });
}

function seqsOf(sessionId: string): number[] {
  return listEvents(db, sessionId, 0, 500).map((event) => event.seq);
}

describe('dropOldestTerminalOutput (retenção do terminal)', () => {
  it('apaga os terminal_output mais antigos (por seq) até liberar os bytes pedidos', () => {
    const seqs = [output('t1', 10), output('t1', 10), output('t1', 10), output('t1', 10)];

    const freed = dropOldestTerminalOutput(db, 't1', 25);

    expect(freed).toBe(30);
    expect(seqsOf('t1')).toEqual(seqs.slice(3));
  });

  it('não toca em outras sessões nem em eventos que não são terminal_output', () => {
    const kept = insertEvent(db, { sessionId: 't1', ts: 1, kind: 'terminal_exit', payload: '{"kind":"terminal_exit","exitCode":3}' });
    output('t1', 10);
    const other = output('t2', 10);

    dropOldestTerminalOutput(db, 't1', 10_000);

    expect(seqsOf('t1')).toEqual([kept]);
    expect(seqsOf('t2')).toEqual([other]);
  });

  it('o replay com afterSeq continua certo depois de apagar o início', () => {
    output('t1', 10);
    const second = output('t1', 10);
    const third = output('t1', 10);
    dropOldestTerminalOutput(db, 't1', 10);

    expect(listEvents(db, 't1', 0, 500).map((event) => event.seq)).toEqual([second, third]);
    expect(listEvents(db, 't1', second, 500).map((event) => event.seq)).toEqual([third]);
  });

  it('sem nada para apagar devolve 0', () => {
    expect(dropOldestTerminalOutput(db, 'vazia', 100)).toBe(0);
  });
});
