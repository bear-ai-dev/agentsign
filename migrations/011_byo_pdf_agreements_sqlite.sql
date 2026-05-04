-- @target sqlite

ALTER TABLE agreements ADD COLUMN original_pdf_base64 TEXT;
ALTER TABLE agreements ADD COLUMN original_pdf_filename TEXT;
ALTER TABLE agreements ADD COLUMN original_pdf_sha256 TEXT;
ALTER TABLE agreements ADD COLUMN original_pdf_bytes INTEGER;

CREATE INDEX IF NOT EXISTS idx_agreements_original_pdf_sha256 ON agreements(original_pdf_sha256) WHERE original_pdf_sha256 IS NOT NULL;
