import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import {
  ensureMachine,
  findSessionById,
  findSessionCommands,
  insertSession,
  insertWorkspace,
  updateSession,
} from '../src/repository.js';
import { removeTempDir } from './temp.js';

let dir: string;
let db: Database.Database | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nanachi-db-'));
});

afterEach(async () => {
  db?.close();
  db = undefined;
  await removeTempDir(dir);
});

function tableNames(database: Database.Database): string[] {
  return database
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

describe('openDatabase', () => {
  it('cria as tabelas das migrações 1 a 8 e fixa user_version em 8', () => {
    db = openDatabase(join(dir, 'data.db'));
    expect(tableNames(db)).toEqual([
      'devices',
      'events',
      'files',
      'loops',
      'machine',
      'pair_codes',
      'push_subscriptions',
      'sessions',
      'workspaces',
    ]);
    expect(db.pragma('user_version', { simple: true })).toBe(8);
  });

  it('migração 5: sessions.worktree é TEXT anulável (sem worktree = NULL)', () => {
    db = openDatabase(join(dir, 'data.db'));
    const column = db
      .prepare<[], { name: string; type: string; notnull: number }>('PRAGMA table_info(sessions)')
      .all()
      .find((row) => row.name === 'worktree');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 0 });
  });

  it('migração 4: sessions.kind é NOT NULL com padrão acp e só aceita acp ou pty', () => {
    db = openDatabase(join(dir, 'data.db'));
    const column = db
      .prepare<[], { name: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(sessions)')
      .all()
      .find((row) => row.name === 'kind');
    expect(column).toMatchObject({ notnull: 1, dflt_value: "'acp'" });

    db.prepare('INSERT INTO sessions (id, workspace_id, agent, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('s1', 'w', 'omp', 't', 'idle', 0, 0);
    expect(db.prepare<[], { kind: string }>("SELECT kind FROM sessions WHERE id = 's1'").get()).toEqual({ kind: 'acp' });
    expect(() =>
      db?.prepare("INSERT INTO sessions (id, workspace_id, agent, title, status, kind, created_at, updated_at) VALUES ('s2', 'w', 'omp', 't', 'idle', 'outro', 0, 0)").run(),
    ).toThrow();
  });

  it('migração 3: files guarda direção restrita e push_subscriptions tem endpoint como chave', () => {
    db = openDatabase(join(dir, 'data.db'));
    const columns = (table: string): string[] =>
      db!.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((row) => row.name);

    expect(columns('files')).toEqual(['id', 'session_id', 'name', 'mime', 'size', 'direction', 'path', 'created_at']);
    expect(columns('push_subscriptions')).toEqual(['endpoint', 'device_id', 'keys', 'created_at']);
    expect(() =>
      db!.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('f1', 's1', 'a', 'a/b', 1, 'outro', 'p', 0),
    ).toThrow(/CHECK/);
  });

  it('migração 3: workspaces.muted é INTEGER NOT NULL DEFAULT 0 (linhas antigas ficam não silenciadas)', () => {
    db = openDatabase(join(dir, 'data.db'));
    db.prepare('INSERT INTO workspaces (id, name, path, created_at) VALUES (?, ?, ?, ?)').run('w1', 'w', '/w', 0);

    const row = db.prepare<[], { muted: number }>("SELECT muted FROM workspaces WHERE id = 'w1'").get();
    expect(row).toEqual({ muted: 0 });
  });

  it('migração 6: sessions.commands é TEXT NOT NULL com padrão []', () => {
    db = openDatabase(join(dir, 'data.db'));
    const column = db
      .prepare<[], { name: string; type: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(sessions)')
      .all()
      .find((row) => row.name === 'commands');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "'[]'" });
  });

  it('comandos gravados na sessão voltam em findSessionCommands, também com ela parada, e fora da Session', () => {
    db = openDatabase(join(dir, 'data.db'));
    insertWorkspace(db, { id: 'w-1', name: 'app', path: 'C:\app', createdAt: 1, muted: false });
    insertSession(db, { id: 's-1', workspaceId: 'w-1', agent: 'claude', title: 'x', status: 'idle', createdAt: 1 });
    const commands = [{ name: 'loop', description: 'Repete', hint: '[intervalo] [prompt]' }];
    updateSession(db, 's-1', { commands }, 2);
    db.prepare("UPDATE sessions SET status = 'stopped' WHERE id = 's-1'").run();
    expect(findSessionCommands(db, 's-1')).toEqual(commands);
    expect(findSessionById(db, 's-1')?.status).toBe('stopped');
    expect(findSessionById(db, 's-1')).not.toHaveProperty('commands');
  });

  it('findSessionCommands de sessão inexistente é undefined', () => {
    db = openDatabase(join(dir, 'data.db'));
    expect(findSessionCommands(db, 'nao-existe')).toBeUndefined();
  });

  it('sessions guarda config_options como JSON obrigatório, com padrão []', () => {
    db = openDatabase(join(dir, 'data.db'));
    const column = db
      .prepare<[], { name: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(sessions)')
      .all()
      .find((row) => row.name === 'config_options');
    expect(column).toEqual({ name: 'config_options', type: 'TEXT', notnull: 1, dflt_value: "'[]'", pk: 0, cid: expect.any(Number) });
  });

  it('events tem índice (session_id, seq) para ler em ordem por sessão', () => {
    db = openDatabase(join(dir, 'data.db'));
    const columns = db
      .prepare<[], { name: string }>("PRAGMA index_info('events_session_seq')")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(['session_id', 'seq']);
  });

  it('guarda só token_hash em devices, nunca o token em claro', () => {
    db = openDatabase(join(dir, 'data.db'));
    const columns = db
      .prepare<[], { name: string }>('PRAGMA table_info(devices)')
      .all()
      .map((column) => column.name);
    expect(columns).toContain('token_hash');
    expect(columns).not.toContain('token');
  });

  it('reabrir um banco já migrado mantém a versão e os dados', () => {
    db = openDatabase(join(dir, 'data.db'));
    ensureMachine(db, 'PC');
    db.close();

    db = openDatabase(join(dir, 'data.db'));
    expect(db.pragma('user_version', { simple: true })).toBe(8);
    expect(ensureMachine(db, 'PC').name).toBe('PC');
  });

  it('cria a pasta do arquivo quando ela não existe', () => {
    db = openDatabase(join(dir, 'sub', 'pasta', 'data.db'));
    expect(tableNames(db)).toContain('machine');
  });
});

describe('ensureMachine', () => {
  it('cria a máquina na primeira chamada e mantém o mesmo id depois', () => {
    db = openDatabase(join(dir, 'data.db'));
    const first = ensureMachine(db, 'PC-A');
    const second = ensureMachine(db, 'PC-A');

    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM machine').get()).toEqual({ count: 1 });
  });

  it('atualiza o nome quando o config muda, sem trocar o id', () => {
    db = openDatabase(join(dir, 'data.db'));
    const first = ensureMachine(db, 'PC-A');
    const renamed = ensureMachine(db, 'PC-B');

    expect(renamed).toEqual({ id: first.id, name: 'PC-B' });
  });
});
