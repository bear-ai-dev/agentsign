CREATE TABLE agreements (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('sent', 'viewed', 'completed', 'declined', 'expired', 'cancelled')),
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  document_markdown TEXT NOT NULL,
  document_title TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  signed_fields_json TEXT,
  webhook_url TEXT,
  webhook_secret TEXT,
  metadata_json TEXT,
  signing_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  viewed_at TEXT,
  completed_at TEXT,
  signed_pdf_path TEXT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES agreements(id),
  url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status_code INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  error TEXT
);

CREATE INDEX idx_agreements_status ON agreements(status);
CREATE INDEX idx_agreements_signing_token ON agreements(signing_token);
CREATE INDEX idx_audit_events_agreement ON audit_events(agreement_id);
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries(next_retry_at) WHERE delivered_at IS NULL;
