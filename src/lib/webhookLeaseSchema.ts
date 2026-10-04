export const webhookLeasePrivilegesSql = `DO $privileges$
BEGIN
  REVOKE ALL ON webhook_delivery_leases FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON webhook_delivery_leases FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON webhook_delivery_leases FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_delivery_leases TO service_role;
  END IF;
END $privileges$`;
