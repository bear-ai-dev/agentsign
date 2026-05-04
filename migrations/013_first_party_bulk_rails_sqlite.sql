-- @target sqlite

ALTER TABLE agreements ADD COLUMN sender_profile_id TEXT;
ALTER TABLE agreements ADD COLUMN signing_base_url TEXT;
ALTER TABLE agreements ADD COLUMN batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agreements_sender_profile_id ON agreements(sender_profile_id);
CREATE INDEX IF NOT EXISTS idx_agreements_batch_id ON agreements(batch_id);

CREATE TABLE IF NOT EXISTS sender_profiles (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  email_domain TEXT NOT NULL,
  signing_domain TEXT NOT NULL,
  default_from_email TEXT NOT NULL,
  default_from_name TEXT,
  resend_domain_id TEXT,
  email_domain_status TEXT NOT NULL DEFAULT 'pending',
  signing_domain_status TEXT NOT NULL DEFAULT 'pending',
  email_dns_records_json TEXT,
  signing_dns_records_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sender_profiles_owner_email ON sender_profiles(owner_email);
CREATE INDEX IF NOT EXISTS idx_sender_profiles_email_domain ON sender_profiles(email_domain);
CREATE INDEX IF NOT EXISTS idx_sender_profiles_signing_domain ON sender_profiles(signing_domain);

CREATE TABLE IF NOT EXISTS agreement_batches (
  id TEXT PRIMARY KEY,
  owner_email TEXT,
  api_key_id TEXT,
  sender_profile_id TEXT,
  status TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agreement_batches_owner_email ON agreement_batches(owner_email, created_at);

CREATE TABLE IF NOT EXISTS agreement_batch_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  agreement_id TEXT,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agreement_batch_items_batch_id ON agreement_batch_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_agreement_batch_items_agreement_id ON agreement_batch_items(agreement_id);
