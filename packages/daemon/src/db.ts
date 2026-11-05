import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** Cada entrada leva o banco da versão i-1 para i (user_version). Nunca editar entradas já lançadas. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE machine (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at   INTEGER
  );
  CREATE TABLE pair_codes (
    code       TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  `,
  `
  CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL,
    agent          TEXT NOT NULL,
    title          TEXT NOT NULL,
    status         TEXT NOT NULL,
    acp_session_id TEXT,
    config_options TEXT NOT NULL DEFAULT '[]',
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE TABLE events (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL
  );
  CREATE INDEX events_session_seq ON events (session_id, seq);
  `,
  `
  ALTER TABLE workspaces ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE files (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    direction  TEXT NOT NULL CHECK (direction IN ('to_phone', 'from_phone')),
    path       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    keys       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'acp' CHECK (kind IN ('acp', 'pty'));
  `,
  `
  ALTER TABLE sessions ADD COLUMN worktree TEXT NULL;
  `,
  `
  ALTER TABLE sessions ADD COLUMN commands TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE loops (
    session_id     TEXT PRIMARY KEY,
    prompt         TEXT NOT NULL,
    mode           TEXT NOT NULL CHECK (mode IN ('interval', 'dynamic')),
    interval_ms    INTEGER NULL,
    max_iterations INTEGER NULL,
    iterations     INTEGER NOT NULL DEFAULT 0,
    state          TEXT NOT NULL CHECK (state IN ('active', 'paused', 'stopped')),
    next_run_at    INTEGER NULL,
    last_run_at    INTEGER NULL,
    last_error     TEXT NULL,
    created_at     INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE devices ADD COLUMN pair_method TEXT NOT NULL DEFAULT 'code' CHECK (pair_method IN ('code', 'tailscale'));
  `,
];

/** Abre (criando a pasta se preciso) o SQLite do daemon e aplica as migrações pendentes. */
export function openDatabase(file: string): Database.Database {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true });
  if (typeof current !== 'number') throw new Error('user_version inesperado');

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) throw new Error(`migração ${version + 1} ausente`);
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
