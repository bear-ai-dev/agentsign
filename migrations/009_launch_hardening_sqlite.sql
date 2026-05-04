-- @target sqlite

ALTER TABLE agreements ADD COLUMN owner_email TEXT;
ALTER TABLE agreements ADD COLUMN api_key_id TEXT;

UPDATE agreements
SET owner_email = json_extract(metadata_json, '$.sender_email')
WHERE owner_email IS NULL
  AND metadata_json IS NOT NULL
  AND json_valid(metadata_json)
  AND json_extract(metadata_json, '$.sender_email') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agreements_owner_email ON agreements(owner_email);
CREATE INDEX IF NOT EXISTS idx_agreements_api_key_id ON agreements(api_key_id);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_lookup ON rate_limit_events(scope, subject, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_created_at ON rate_limit_events(created_at);
