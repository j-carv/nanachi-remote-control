import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { LearningMemory } from '../src/learning-memory.js';
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

/** Published version-12 learning schema, also present unchanged in version 13. */
function createLegacyLearningStore(database: Database.Database): void {
  database.exec(`
    CREATE TABLE learning_entries (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('memory', 'skill')),
      title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'deleted')), version INTEGER NOT NULL,
      source_session_id TEXT, evidence_seqs TEXT NOT NULL, review_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX learning_entries_workspace ON learning_entries (workspace_id, status, kind);
    CREATE VIRTUAL TABLE learning_search USING fts5(title, content, tokenize = 'unicode61 remove_diacritics 2');
    CREATE TRIGGER learning_search_ai AFTER INSERT ON learning_entries BEGIN
      INSERT INTO learning_search (rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
    END;
    CREATE TRIGGER learning_search_au AFTER UPDATE ON learning_entries BEGIN
      DELETE FROM learning_search WHERE rowid = OLD.rowid;
      INSERT INTO learning_search (rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
    END;
    CREATE TRIGGER learning_search_ad AFTER DELETE ON learning_entries BEGIN
      DELETE FROM learning_search WHERE rowid = OLD.rowid;
    END;
    CREATE TABLE learning_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      snapshot TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE learning_tombstones (
      workspace_id TEXT NOT NULL, kind TEXT NOT NULL, content_hash TEXT NOT NULL,
      source_session_id TEXT, evidence_seqs TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, kind, content_hash)
    );
    CREATE TABLE learning_reviews (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
      source_turn_seq INTEGER NOT NULL, summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'reverted')), created_at INTEGER NOT NULL
    );
    CREATE TABLE learning_review_changes (
      review_id TEXT NOT NULL, proposal_id TEXT NOT NULL, target_id TEXT NOT NULL,
      before_json TEXT, proposal_json TEXT NOT NULL, PRIMARY KEY (review_id, proposal_id)
    );
    CREATE TABLE learning_review_applied (
      review_id TEXT NOT NULL, entry_id TEXT NOT NULL, before_json TEXT,
      after_version INTEGER NOT NULL, PRIMARY KEY (review_id, entry_id)
    );
  `);
}

describe('openDatabase', () => {
  it('migration 11: push_subscriptions.language is a nullable TEXT (no language = NULL, pt-BR)', () => {
    db = openDatabase(join(dir, 'data.db'));
    const column = db
      .prepare<[], { name: string; type: string; notnull: number }>('PRAGMA table_info(push_subscriptions)')
      .all()
      .find((row) => row.name === 'language');
    expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
  });

  it('migration 11 on a database already at version 10: gains the column and old subscriptions have no language', () => {
    const file = join(dir, 'data.db');
    const legacy = new BetterSqlite3(file);
    legacy.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        device_id  TEXT NOT NULL,
        keys       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO push_subscriptions VALUES ('https://push.example.test/old', 'd1', '{"p256dh":"p","auth":"a"}', 1);
    `);
    legacy.pragma('user_version = 10');
    legacy.close();

    db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(14);
    expect(db.prepare<[], { endpoint: string; language: string | null }>('SELECT endpoint, language FROM push_subscriptions').all()).toEqual([
      { endpoint: 'https://push.example.test/old', language: null },
    ]);
  });

  it('migration 13 preserves existing sessions and adds nullable automation ownership', () => {
    const file = join(dir, 'data.db');
    const legacy = new BetterSqlite3(file);
    legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('ordinary');");
    createLegacyLearningStore(legacy);
    legacy.pragma('user_version = 12');
    legacy.close();

    db = openDatabase(file);
    expect(db.prepare('SELECT id, automation_run_id FROM sessions').all()).toEqual([
      { id: 'ordinary', automation_run_id: null },
    ]);
    expect(tableNames(db)).toEqual(expect.arrayContaining(['schedules', 'schedule_runs']));
  });

  it('migration 14 retains legacy rowids, FTS, history and review snapshots while enabling nullable global origins', () => {
    const file = join(dir, 'data.db');
    const legacy = new BetterSqlite3(file);
    createLegacyLearningStore(legacy);
    legacy.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
      INSERT INTO workspaces VALUES ('w1', 'Original project', '/original'), ('w2', 'Other project', '/other');
      CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
      INSERT INTO sessions VALUES ('s2', 'w2');
      CREATE TABLE events (seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL);
      INSERT INTO events VALUES (20, 's2', 'user_message');
    `);
    const before = { id: '11111111-1111-4111-8111-111111111111', workspaceId: 'w1', kind: 'memory', title: 'Legacy convention', content: 'Original legacy convention.', status: 'active', version: 3, sourceSessionId: 's1', evidenceSeqs: [10], reviewId: null, createdAt: 1, updatedAt: 2 };
    const active = { ...before, content: 'Updated legacy convention.', version: 4, reviewId: '22222222-2222-4222-8222-222222222222' };
    const pending = { ...before, id: '33333333-3333-4333-8333-333333333333', title: 'Legacy procedure', content: 'Pending legacy procedure.', status: 'pending', version: 1, reviewId: '44444444-4444-4444-8444-444444444444' };
    const deleted = { ...before, id: '55555555-5555-4555-8555-555555555555', content: 'Forgotten legacy convention.', status: 'deleted', version: 8 };
    const insert = legacy.prepare('INSERT INTO learning_entries (rowid, id, workspace_id, kind, title, content, content_hash, status, version, source_session_id, evidence_seqs, review_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [rowid, entry] of [[73, active], [91, pending], [110, deleted]] as const) {
      insert.run(rowid, entry.id, entry.workspaceId, entry.kind, entry.title, entry.content, createHash('sha256').update(entry.content.toLowerCase()).digest('hex'), entry.status, entry.version, entry.sourceSessionId, JSON.stringify(entry.evidenceSeqs), entry.reviewId, entry.createdAt, entry.updatedAt);
    }
    const history = legacy.prepare('INSERT INTO learning_history (seq, workspace_id, entry_id, snapshot, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    history.run(40, 'w1', active.id, JSON.stringify(active), 'review_apply', 2);
    history.run(41, 'w1', pending.id, JSON.stringify(pending), 'review_pending', 2);
    legacy.prepare("UPDATE sqlite_sequence SET seq = 100 WHERE name = 'learning_history'").run();
    const review = legacy.prepare('INSERT INTO learning_reviews VALUES (?, ?, ?, ?, ?, ?, ?)');
    review.run(active.reviewId, 'w1', 's1', 11, 'Existing applied review', 'applied', 2);
    review.run(pending.reviewId, 'w1', 's1', 12, 'Existing pending review', 'pending', 2);
    legacy.prepare('INSERT INTO learning_review_applied VALUES (?, ?, ?, ?)').run(active.reviewId, active.id, JSON.stringify(before), 4);
    legacy.prepare('INSERT INTO learning_review_changes VALUES (?, ?, ?, ?, ?)').run(pending.reviewId, pending.id, pending.id, null, JSON.stringify(pending));
    legacy.prepare('INSERT INTO learning_tombstones VALUES (?, ?, ?, ?, ?, ?)').run('w1', 'memory', createHash('sha256').update(deleted.content.toLowerCase()).digest('hex'), 's1', '[10]', 2);
    const rows = legacy.prepare('SELECT rowid, * FROM learning_entries ORDER BY rowid').all();
    const historyRows = legacy.prepare('SELECT * FROM learning_history ORDER BY seq').all();
    const reviewRows = legacy.prepare('SELECT * FROM learning_reviews ORDER BY id').all();
    const changes = legacy.prepare('SELECT * FROM learning_review_changes').all();
    const appliedRows = legacy.prepare('SELECT * FROM learning_review_applied').all();
    legacy.pragma('user_version = 13');
    legacy.close();

    db = openDatabase(file);
    expect(db.pragma('user_version', { simple: true })).toBe(14);
    expect(db.prepare('SELECT rowid, * FROM learning_entries ORDER BY rowid').all()).toEqual(rows);
    expect(db.prepare('SELECT * FROM learning_history ORDER BY seq').all()).toEqual(historyRows);
    expect(db.prepare('SELECT * FROM learning_reviews ORDER BY id').all()).toEqual(reviewRows);
    expect(db.prepare('SELECT * FROM learning_review_changes').all()).toEqual(changes);
    expect(db.prepare('SELECT * FROM learning_review_applied').all()).toEqual(appliedRows);
    const memory = new LearningMemory(db);
    expect(memory.list({ query: 'updated legacy' })).toMatchObject([{ id: active.id, version: 4, sourceWorkspace: { id: 'w1', name: 'Original project', path: '/original' } }]);
    expect(memory.read(deleted.id)).toMatchObject({ status: 'deleted', version: 8 });
    const manual = memory.save({ kind: 'skill', title: 'Global owner procedure', content: 'A manual global procedure.', evidenceSeqs: [] });
    expect(manual).toMatchObject({ workspaceId: null, sourceWorkspace: null });
    expect(db.prepare<[], { seq: number }>('SELECT MAX(seq) AS seq FROM learning_history').get()?.seq).toBe(101);
    memory.forget(manual.id, manual.version);
    expect(() => memory.save({ kind: 'memory', title: 'Forgotten in another project', content: deleted.content, evidenceSeqs: [20] }, { workspaceId: 'w2', sessionId: 's2' })).toThrow();
    db.prepare("DELETE FROM workspaces WHERE id = 'w1'").run();
    expect(memory.read(active.id)).toMatchObject({ workspaceId: 'w1', sourceWorkspace: null });
    expect(memory.manageReview(active.reviewId, 'revert')).toMatchObject({ status: 'reverted' });
    expect(memory.read(active.id)).toMatchObject({ content: before.content, version: 5, sourceWorkspace: null });
    expect(memory.manageReview(pending.reviewId, 'approve')).toMatchObject({ status: 'applied' });
    expect(memory.manageReview(pending.reviewId, 'revert')).toMatchObject({ status: 'reverted' });
    const edited = memory.save({ id: active.id, expectedVersion: 5, kind: 'memory', title: active.title, content: 'FTS remains synchronized after migration.', evidenceSeqs: [] });
    expect(memory.list({ query: 'synchronized' })).toMatchObject([{ id: edited.id, workspaceId: 'w1', sourceWorkspace: null }]);
    memory.forget(edited.id, edited.version);
    expect(memory.list({ query: 'synchronized' })).toEqual([]);
  });

  it('migração 9: sessions.account_id é TEXT anulável (sem conta = NULL, a principal), e as contas de agente são únicas por id', () => {
    db = openDatabase(join(dir, 'data.db'));
    const column = db
      .prepare<[], { name: string; type: string; notnull: number }>('PRAGMA table_info(sessions)')
      .all()
      .find((row) => row.name === 'account_id');
    expect(column).toEqual({ cid: expect.any(Number), name: 'account_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
    const accounts = db
      .prepare<[], { name: string; pk: number }>('PRAGMA table_info(agent_accounts)')
      .all()
      .filter((row) => row.pk === 1)
      .map((row) => row.name);
    expect(accounts).toEqual(['id']);
    const active = db
      .prepare<[], { name: string; pk: number }>('PRAGMA table_info(agent_active_account)')
      .all()
      .filter((row) => row.pk === 1)
      .map((row) => row.name);
    expect(active).toEqual(['agent']);
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
    expect(columns('push_subscriptions')).toEqual(['endpoint', 'device_id', 'keys', 'created_at', 'language']);
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
    const version = db.pragma('user_version', { simple: true });
    db.close();

    db = openDatabase(join(dir, 'data.db'));
    expect(db.pragma('user_version', { simple: true })).toBe(version);
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
