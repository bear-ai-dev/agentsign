CREATE TABLE IF NOT EXISTS webhook_delivery_leases (
  delivery_id TEXT PRIMARY KEY REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_leases_expiry ON webhook_delivery_leases(expires_at);
