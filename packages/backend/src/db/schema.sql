-- Demo login sessions. Stand-in for a real auth layer: every OAuth flow and
-- every credential handle is bound to one of these.
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  business_uid TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- One row per started OAuth flow (M1). The state is only ever accepted back
-- from the same session that started the flow, and only once.
CREATE TABLE IF NOT EXISTS oauth_flows (
  payload_id      TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  business_uid    TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  state           TEXT NOT NULL,
  verifier_cipher TEXT,
  redirect_uri    TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_flows_session ON oauth_flows (session_id, provider);

-- Completed connections. Tokens/credentials exist only as ciphertext.
CREATE TABLE IF NOT EXISTS connections (
  payload_id    TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  business_uid  TEXT NOT NULL,
  member_id     TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  details_json  TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connections_business ON connections (business_uid);

-- Two-step credential hand-off (M3): credentials arrive in a POST body and are
-- redeemed once, by the same member of the same business, within the TTL.
CREATE TABLE IF NOT EXISTS pending_connections (
  pending_id         TEXT PRIMARY KEY,
  business_uid       TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  app                TEXT NOT NULL,
  connection_name    TEXT NOT NULL,
  credentials_cipher TEXT NOT NULL,
  expires_at         INTEGER NOT NULL,
  consumed           INTEGER NOT NULL DEFAULT 0,
  consumed_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_connections (expires_at);

-- Server-side page token vault (M2).
CREATE TABLE IF NOT EXISTS meta_page_tokens (
  business_uid TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  channel_uid  TEXT,
  token_cipher TEXT NOT NULL,
  name         TEXT NOT NULL,
  category     TEXT,
  tasks_json   TEXT NOT NULL DEFAULT '[]',
  updated_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  UNIQUE (business_uid, page_id)
);
