ALTER TABLE agreements ADD COLUMN owner_email TEXT;

CREATE INDEX IF NOT EXISTS idx_agreements_owner_email
  ON agreements(owner_email)
  WHERE owner_email IS NOT NULL;
