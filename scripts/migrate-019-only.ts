import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { verifiedPostgresSsl } from "../src/lib/postgres.js";
import { webhookLeasePrivilegesSql } from "../src/lib/webhookLeaseSchema.js";

export const migration019Name = "019_webhook_delivery_leases.sql";
export const migration018Name = "018_agreement_owner_isolation.sql";
export const migration019Checksum = "58406f49f603f0fb100e792567770ad0e6ef08a757ec36bcebac350b7ee605e5";
const project = "qfwebwnmmwnqwhlsxzoo";

type Options = { databaseUrl: string; expected018Checksum: string; apply: boolean; localFixture?: boolean; caCertificate?: string };

export function guarded019Target(options: Options) {
  if (!/^e365a934[a-f0-9]{56}$/.test(options.expected018Checksum)) throw new Error("Supply the full verified 018 SHA-256 beginning e365a934");
  const url = new URL(options.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash) throw new Error("PostgreSQL target must have no URL options or fragment");
  const database = decodeURIComponent(url.pathname.slice(1));
  const username = decodeURIComponent(url.username);
  if (options.localFixture) {
    if (url.hostname !== "127.0.0.1" || url.port !== "55438" || username !== "voice_test" || !/^agentsign_019_only_[a-z0-9_]+$/.test(database)) throw new Error("Local execution requires a uniquely named disposable agentsign_019_only_ database on the fixture server");
    return { ssl: false as const, label: "disposable-local-fixture" };
  }
  if (url.hostname !== "aws-0-us-west-1.pooler.supabase.com" || !["5432", "6543"].includes(url.port) || username !== `postgres.${project}` || database !== "postgres") throw new Error("019 target does not match the approved Supabase pooler/project/database");
  if (!options.caCertificate?.trim()) throw new Error("Explicit DATABASE_CA_CERT is required for the approved production target");
  return { ssl: verifiedPostgresSsl(options.databaseUrl, options.caCertificate), label: project };
}

async function columns(client: pg.PoolClient, table: string, expected: Record<string, string>, exact = false) {
  const rows = (await client.query<{ column_name: string; data_type: string; is_nullable: string }>("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table])).rows;
  if (exact && rows.length !== Object.keys(expected).length) throw new Error(`Conflicting ${table} column set`);
  for (const [name, type] of Object.entries(expected)) if (!rows.some(row => row.column_name === name && row.data_type === type)) throw new Error(`Prerequisite schema mismatch: ${table}.${name} must be ${type}`);
  return rows;
}

async function primaryKey(client: pg.PoolClient, table: string, column: string) {
  const rows = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='p'", [`public.${table}`])).rows;
  if (rows.length !== 1 || rows[0].definition !== `PRIMARY KEY (${column})`) throw new Error(`Prerequisite primary key mismatch: ${table}`);
}

async function verifyLeaseSchema(client: pg.PoolClient) {
  const present = (await client.query("SELECT to_regclass('public.webhook_delivery_leases') AS table_id, to_regclass('public.idx_webhook_delivery_leases_expiry') AS index_id")).rows[0];
  if (!present.table_id) {
    if (present.index_id) throw new Error("Conflicting lease expiry index exists without the lease table");
    return false;
  }
  const rows = await columns(client, "webhook_delivery_leases", { delivery_id: "text", token: "text", expires_at: "text" }, true);
  if (rows.some(row => row.is_nullable !== "NO")) throw new Error("Conflicting nullable lease columns");
  await primaryKey(client, "webhook_delivery_leases", "delivery_id");
  const constraints = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.webhook_delivery_leases'::regclass AND contype <> 'p'")).rows;
  if (constraints.length !== 1 || constraints[0].definition !== "FOREIGN KEY (delivery_id) REFERENCES webhook_deliveries(id) ON DELETE CASCADE") throw new Error("Conflicting lease foreign key");
  const index = (await client.query("SELECT pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid, i.indisready FROM pg_index i WHERE i.indexrelid=to_regclass('public.idx_webhook_delivery_leases_expiry')")).rows[0];
  if (!index || !index.indisvalid || !index.indisready || index.definition !== "CREATE INDEX idx_webhook_delivery_leases_expiry ON public.webhook_delivery_leases USING btree (expires_at)") throw new Error("Conflicting or missing lease expiry index");
  return true;
}

export async function migrate019Only(options: Options) {
  const target = guarded019Target(options);
  const sql = readFileSync(new URL("../migrations/019_webhook_delivery_leases.sql", import.meta.url), "utf8");
  if (createHash("sha256").update(sql).digest("hex") !== migration019Checksum) throw new Error("019 source checksum differs from the reviewed migration");
  const pool = new pg.Pool({ connectionString: options.databaseUrl, ssl: target.ssl, max: 1 });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query(options.apply ? "BEGIN" : "BEGIN READ ONLY");
    await client.query("SET LOCAL search_path = public, pg_temp");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SELECT pg_advisory_xact_lock(424242019)");
    const identity = (await client.query("SELECT current_database() AS database, session_user AS username")).rows[0];
    const intended = new URL(options.databaseUrl);
    if (identity.database !== decodeURIComponent(intended.pathname.slice(1)) || identity.username !== decodeURIComponent(intended.username).split(".")[0]) throw new Error("Connected database/session identity differs from the guarded target");
    await columns(client, "schema_migrations", { filename: "text", checksum: "text", applied_at: "text" });
    await primaryKey(client, "schema_migrations", "filename");
    const prior = (await client.query("SELECT filename, checksum FROM schema_migrations WHERE left(filename,4)='018_' ORDER BY filename")).rows;
    if (prior.length !== 1 || prior[0].filename !== migration018Name || prior[0].checksum !== options.expected018Checksum) throw new Error("018 ledger identity/checksum conflicts with the verified production baseline");
    await columns(client, "agreements", { id: "text", owner_email: "text", webhook_secret: "text" });
    await primaryKey(client, "agreements", "id");
    await columns(client, "webhook_deliveries", { id: "text", agreement_id: "text", url: "text", payload_json: "text", attempts: "integer", status_code: "integer", delivered_at: "text", last_attempt_at: "text", next_retry_at: "text", error: "text" });
    await primaryKey(client, "webhook_deliveries", "id");
    const ledger = (await client.query("SELECT filename, checksum FROM schema_migrations WHERE left(filename,4)='019_' ORDER BY filename")).rows;
    if (ledger.length && (ledger.length !== 1 || ledger[0].filename !== migration019Name || ledger[0].checksum !== migration019Checksum)) throw new Error("019 ledger filename/checksum conflict");
    const exists = await verifyLeaseSchema(client);
    if (ledger.length && !exists) throw new Error("019 ledger is applied but its lease schema is absent");
    if (options.apply) {
      await client.query(sql);
      await verifyLeaseSchema(client);
      await client.query(webhookLeasePrivilegesSql);
      if (!ledger.length) await client.query("INSERT INTO schema_migrations (filename,checksum,applied_at) VALUES ($1,$2,$3)", [migration019Name, migration019Checksum, new Date().toISOString()]);
    }
    await client.query(options.apply ? "COMMIT" : "ROLLBACK");
    return { target: target.label, mode: options.apply ? "apply" : "read-only", status: ledger.length ? "already-applied" : exists ? "schema-present-ledger-pending" : "pending", filename: migration019Name, checksum: migration019Checksum };
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client?.release(); await pool.end(); }
}

async function main() {
  const args = process.argv.slice(2);
  const expected = args.find(arg => arg.startsWith("--expected-018-sha256="))?.slice("--expected-018-sha256=".length) ?? "";
  if (args.some(arg => !["--apply", "--dry-run", "--local-fixture"].includes(arg) && !arg.startsWith("--expected-018-sha256=")) || args.filter(arg => ["--apply", "--dry-run"].includes(arg)).length !== 1) throw new Error("Use exactly one of --dry-run / --apply and --expected-018-sha256=<verified-full-hash>");
  const result = await migrate019Only({ databaseUrl: process.env.DATABASE_URL ?? "", caCertificate: process.env.DATABASE_CA_CERT, expected018Checksum: expected, apply: args.includes("--apply"), localFixture: args.includes("--local-fixture") });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => {
  console.error("019-only migration failed; target, baseline, schema, TLS or atomic apply verification rejected. No credentials are printed; inspect using approved read-only checks.");
  process.exitCode = 1;
});
