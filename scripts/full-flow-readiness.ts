import pg from "pg";
import { verifiedPostgresSsl } from "../src/lib/postgres.js";

const url = process.env.DATABASE_URL;
if (!url || new URL(url).hostname !== "aws-0-us-west-1.pooler.supabase.com") throw new Error("Verified AgentSign database required");
const pool = new pg.Pool({ connectionString: url, ssl: verifiedPostgresSsl(url), max: 1, connectionTimeoutMillis: 10000 });
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '20s'");
  const identity = await client.query("SELECT current_database() AS database, split_part(current_user,'.',2) AS project");
  const schema = await client.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('agreements','webhook_deliveries','webhook_delivery_leases','schema_migrations') ORDER BY table_name,ordinal_position");
  const migrations = await client.query("SELECT filename,checksum FROM schema_migrations ORDER BY filename");
  await client.query("COMMIT");
  console.log(JSON.stringify({ readOnly: true, identity: identity.rows, schema: schema.rows, migrations: migrations.rows }));
} catch (error) {
  await client.query("ROLLBACK");
  console.error(JSON.stringify({ readOnly: true, error: "agentsign_readiness_failed", code: error && typeof error === "object" && "code" in error ? error.code : null }));
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
