ALTER TABLE agreements ADD COLUMN signing_mode TEXT NOT NULL DEFAULT 'hosted';
ALTER TABLE agreements ADD COLUMN allowed_parent_origins_json TEXT;
ALTER TABLE agreements ADD COLUMN prefill_fields_json TEXT;
ALTER TABLE agreements ADD COLUMN idempotency_scope TEXT;
ALTER TABLE agreements ADD COLUMN idempotency_key TEXT;
ALTER TABLE agreements ADD COLUMN creation_request_sha256 TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreements_idempotency ON agreements(idempotency_scope, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS agreement_signing_sessions (
  token_hash TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  signer_role TEXT NOT NULL CHECK(signer_role IN ('recipient', 'sender')),
  parent_origin TEXT NOT NULL,
  return_url TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agreement_signing_sessions_agreement ON agreement_signing_sessions(agreement_id);
