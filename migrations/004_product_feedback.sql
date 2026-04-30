CREATE TABLE IF NOT EXISTS product_feedback (
  id TEXT PRIMARY KEY,
  owner_email TEXT,
  reporter_email TEXT,
  reporter_name TEXT,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  command TEXT,
  message TEXT NOT NULL,
  expected TEXT,
  actual TEXT,
  context_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('open', 'triaged', 'closed')) DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_feedback_created_at ON product_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_product_feedback_status ON product_feedback(status);
CREATE INDEX IF NOT EXISTS idx_product_feedback_owner_email ON product_feedback(owner_email);
CREATE INDEX IF NOT EXISTS idx_product_feedback_reporter_email ON product_feedback(reporter_email);
