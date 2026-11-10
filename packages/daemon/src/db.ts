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
  `
  CREATE TABLE agent_accounts (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE agent_active_account (
    agent TEXT PRIMARY KEY,
    account_id TEXT NOT NULL
  );
  ALTER TABLE sessions ADD COLUMN account_id TEXT NULL;
  `,
  `
  CREATE VIRTUAL TABLE message_search USING fts5(
    text,
    session_id UNINDEXED,
    ts UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER events_message_search_ai AFTER INSERT ON events
  WHEN NEW.kind IN ('user_message', 'agent_message_chunk') BEGIN
    INSERT INTO message_search (rowid, text, session_id, ts)
    VALUES (NEW.seq, json_extract(NEW.payload, '$.text'), NEW.session_id, NEW.ts);
  END;
  CREATE TRIGGER events_message_search_ad AFTER DELETE ON events
  WHEN OLD.kind IN ('user_message', 'agent_message_chunk') BEGIN
    DELETE FROM message_search WHERE rowid = OLD.seq;
  END;
  INSERT INTO message_search (rowid, text, session_id, ts)
    SELECT seq, json_extract(payload, '$.text'), session_id, ts
    FROM events WHERE kind IN ('user_message', 'agent_message_chunk');
  `,
  `
  ALTER TABLE push_subscriptions ADD COLUMN language TEXT NULL;
  `,
  `
  CREATE TABLE learning_entries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('memory', 'skill')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'deleted')),
    version INTEGER NOT NULL,
    source_session_id TEXT,
    evidence_seqs TEXT NOT NULL,
    review_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX learning_entries_workspace ON learning_entries (workspace_id, status, kind);
  CREATE VIRTUAL TABLE learning_search USING fts5(
    title, content, tokenize = 'unicode61 remove_diacritics 2'
  );
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
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE learning_tombstones (
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_session_id TEXT,
    evidence_seqs TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, kind, content_hash)
  );
  CREATE TABLE learning_reviews (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_turn_seq INTEGER NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'reverted')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE learning_review_changes (
    review_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    before_json TEXT,
    proposal_json TEXT NOT NULL,
    PRIMARY KEY (review_id, proposal_id)
  );
  CREATE TABLE learning_review_applied (
    review_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    before_json TEXT,
    after_version INTEGER NOT NULL,
    PRIMARY KEY (review_id, entry_id)
  );
  `,
  `
  ALTER TABLE sessions ADD COLUMN automation_run_id TEXT NULL;
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    time_zone TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    deletion_pending INTEGER NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0, 1)),
    timeout_ms INTEGER NOT NULL,
    task_json TEXT NOT NULL,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX schedules_workspace ON schedules (workspace_id, created_at);
  CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled = 1 AND next_run_at IS NOT NULL;
  CREATE TABLE schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    schedule_name TEXT NOT NULL,
    task_json TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    status TEXT NOT NULL CHECK (status IN (
      'running', 'awaiting_permission', 'succeeded', 'failed', 'cancelled', 'timed_out', 'missed', 'interrupted'
    )),
    execution_active INTEGER NOT NULL DEFAULT 0 CHECK (execution_active IN (0, 1)),
    scheduled_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    session_id TEXT,
    exit_code INTEGER,
    error TEXT,
    output TEXT NOT NULL DEFAULT '',
    output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1))
  );
  CREATE INDEX schedule_runs_history ON schedule_runs (workspace_id, schedule_id, scheduled_at DESC);
  CREATE UNIQUE INDEX schedule_runs_active ON schedule_runs (schedule_id)
    WHERE execution_active = 1;
  CREATE INDEX schedule_runs_workspace_active ON schedule_runs (workspace_id, execution_active);
  `,
  `
  -- Workspace columns describe origin only. Preserve rowids because FTS refers to them.
  DROP TRIGGER learning_search_ai;
  DROP TRIGGER learning_search_au;
  DROP TRIGGER learning_search_ad;
  CREATE TABLE learning_entries_global (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('memory', 'skill')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'deleted')),
    version INTEGER NOT NULL,
    source_session_id TEXT,
    evidence_seqs TEXT NOT NULL,
    review_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO learning_entries_global (rowid, id, workspace_id, kind, title, content, content_hash, status, version, source_session_id, evidence_seqs, review_id, created_at, updated_at)
    SELECT rowid, id, workspace_id, kind, title, content, content_hash, status, version, source_session_id, evidence_seqs, review_id, created_at, updated_at FROM learning_entries;
  DROP TABLE learning_entries;
  ALTER TABLE learning_entries_global RENAME TO learning_entries;
  CREATE INDEX learning_entries_global_lookup ON learning_entries (kind, content_hash, status);
  CREATE INDEX learning_entries_status ON learning_entries (status, updated_at DESC);
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
  CREATE TABLE learning_history_global (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT,
    entry_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  INSERT INTO learning_history_global SELECT * FROM learning_history;
  UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'learning_history'), 0))
    WHERE name = 'learning_history_global';
  DROP TABLE learning_history;
  ALTER TABLE learning_history_global RENAME TO learning_history;
  CREATE TABLE learning_tombstones_global (
    workspace_id TEXT,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_session_id TEXT,
    evidence_seqs TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, kind, content_hash)
  );
  INSERT INTO learning_tombstones_global SELECT * FROM learning_tombstones;
  DROP TABLE learning_tombstones;
  ALTER TABLE learning_tombstones_global RENAME TO learning_tombstones;
  CREATE INDEX learning_tombstones_global_lookup ON learning_tombstones (kind, content_hash);
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
