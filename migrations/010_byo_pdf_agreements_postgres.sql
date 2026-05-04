-- @target postgres

ALTER TABLE public.agreements ADD COLUMN IF NOT EXISTS original_pdf_base64 TEXT;
ALTER TABLE public.agreements ADD COLUMN IF NOT EXISTS original_pdf_filename TEXT;
ALTER TABLE public.agreements ADD COLUMN IF NOT EXISTS original_pdf_sha256 TEXT;
ALTER TABLE public.agreements ADD COLUMN IF NOT EXISTS original_pdf_bytes INTEGER;

CREATE INDEX IF NOT EXISTS idx_agreements_original_pdf_sha256 ON public.agreements(original_pdf_sha256) WHERE original_pdf_sha256 IS NOT NULL;
