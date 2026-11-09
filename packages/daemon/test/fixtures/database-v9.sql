-- Frozen version-9 schema: migration tests must not downgrade a current database.
CREATE TABLE machine (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER,
  pair_method TEXT NOT NULL DEFAULT 'code' CHECK (pair_method IN ('code', 'tailscale'))
);
CREATE TABLE pair_codes (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, muted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL, acp_session_id TEXT,
  config_options TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'acp' CHECK (kind IN ('acp', 'pty')),
  worktree TEXT NULL, commands TEXT NOT NULL DEFAULT '[]', account_id TEXT NULL
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX events_session_seq ON events (session_id, seq);
CREATE TABLE files (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('to_phone', 'from_phone')),
  path TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, device_id TEXT NOT NULL, keys TEXT NOT NULL);
CREATE TABLE loops (
  session_id TEXT PRIMARY KEY, prompt TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('interval', 'dynamic')),
  interval_ms INTEGER NULL, max_iterations INTEGER NULL,
  iterations INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'stopped')),
  next_run_at INTEGER NULL, last_run_at INTEGER NULL, last_error TEXT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE agent_accounts (id TEXT PRIMARY KEY, agent TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE agent_active_account (agent TEXT PRIMARY KEY, account_id TEXT NOT NULL);
PRAGMA user_version = 9;
