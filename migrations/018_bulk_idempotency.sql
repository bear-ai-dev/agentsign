CREATE TABLE IF NOT EXISTS agreement_bulk_requests (
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  creation_request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idempotency_scope, idempotency_key)
);
