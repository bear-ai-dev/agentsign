CREATE TABLE IF NOT EXISTS cli_login_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  key_name TEXT NOT NULL,
  owner_id TEXT,
  owner_email TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cli_login_codes_hash ON cli_login_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_cli_login_codes_pending ON cli_login_codes(expires_at) WHERE used_at IS NULL;
