CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  token_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user ON refresh_tokens(user_id, expires_at);
CREATE TABLE IF NOT EXISTS documents (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL,
  revision bigint NOT NULL,
  body jsonb NOT NULL,
  asset_hashes jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, id)
);
CREATE TABLE IF NOT EXISTS applied_operations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  document_id text NOT NULL,
  resulting_revision bigint NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, operation_id)
);
CREATE INDEX IF NOT EXISTS applied_operations_age ON applied_operations(applied_at);
CREATE TABLE IF NOT EXISTS assets (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 char(64) NOT NULL,
  mime text NOT NULL,
  byte_size bigint NOT NULL,
  object_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, sha256)
);
