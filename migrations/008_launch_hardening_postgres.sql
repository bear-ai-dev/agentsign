-- @target postgres

ALTER TABLE public.agreements ADD COLUMN IF NOT EXISTS owner_email TEXT;
ALTER TABLE public.agreements ADD COLUMN IF NOT EXISTS api_key_id TEXT;

DO $$
DECLARE
  row_to_backfill RECORD;
  sender_email TEXT;
BEGIN
  FOR row_to_backfill IN
    SELECT id, metadata_json
    FROM public.agreements
    WHERE owner_email IS NULL
      AND metadata_json IS NOT NULL
      AND metadata_json <> ''
  LOOP
    BEGIN
      sender_email := row_to_backfill.metadata_json::jsonb ->> 'sender_email';
    EXCEPTION WHEN others THEN
      sender_email := NULL;
    END;

    IF sender_email IS NOT NULL AND sender_email <> '' THEN
      UPDATE public.agreements
      SET owner_email = sender_email
      WHERE id = row_to_backfill.id;
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_agreements_owner_email ON public.agreements(owner_email);
CREATE INDEX IF NOT EXISTS idx_agreements_api_key_id ON public.agreements(api_key_id);

CREATE TABLE IF NOT EXISTS public.rate_limit_events (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_events_lookup ON public.rate_limit_events(scope, subject, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_limit_events_created_at ON public.rate_limit_events(created_at);
ALTER TABLE public.rate_limit_events ENABLE ROW LEVEL SECURITY;
