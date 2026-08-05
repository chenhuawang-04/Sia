BEGIN;
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  local_revision INTEGER NOT NULL DEFAULT 0,
  remote_revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  persisted_at TEXT,
  CHECK(json_valid(body))
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  local_revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(json_valid(body))
);
CREATE INDEX IF NOT EXISTS snapshots_document_revision ON snapshots(document_id, local_revision DESC);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  remote_state TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS assets_live_hash ON assets(sha256) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  local_revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_attempt_at, sequence);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conflicts (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  remote_revision INTEGER NOT NULL,
  local_body TEXT NOT NULL,
  remote_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK(json_valid(local_body)),
  CHECK(json_valid(remote_body))
);
PRAGMA user_version = 1;
COMMIT;
