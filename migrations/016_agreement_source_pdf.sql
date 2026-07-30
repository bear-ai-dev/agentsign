ALTER TABLE agreements ADD COLUMN source_pdf_base64 TEXT;
ALTER TABLE agreements ADD COLUMN source_pdf_sha256 TEXT;
ALTER TABLE agreements ADD COLUMN source_pdf_bytes INTEGER;
ALTER TABLE agreements ADD COLUMN source_pdf_filename TEXT;
