import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { guarded019Target, migrate019Only, migration018Name, migration019Name, migration019Checksum } from "../scripts/migrate-019-only.js";

const checksum018 = "e365a934" + "1".repeat(56);
const execute = promisify(execFile);
const local = process.env.AGENTSIGN_LOCAL_PG_TEST === "true";
const production = "postgresql://postgres.qfwebwnmmwnqwhlsxzoo:synthetic@aws-0-us-west-1.pooler.supabase.com:6543/postgres";

test("019-only target guard rejects another project, unsafe URL options, missing CA and incomplete baseline pin", () => {
  const options = { databaseUrl: production, expected018Checksum: checksum018, apply: false };
  assert.throws(() => guarded019Target(options), /Explicit DATABASE_CA_CERT/);
  for (const databaseUrl of [production.replace("qfwebwnmmwnqwhlsxzoo", "otherproject"), production.replace("aws-0-us-west-1", "aws-0-us-east-1"), production.replace("/postgres", "/other"), production + "?sslmode=disable", production + "#other"]) assert.throws(() => guarded019Target({ ...options, databaseUrl }));
  assert.throws(() => guarded019Target({ ...options, expected018Checksum: "e365a934" }), /full verified/);
  assert.throws(() => guarded019Target({ ...options, caCertificate: "invalid PEM" }), /valid PEM/);
  assert.throws(() => guarded019Target({ ...options, databaseUrl: "postgres://voice_test:synthetic@127.0.0.1:55438/shared", localFixture: true }), /disposable/);
});

async function fixture(work: (client: pg.Client, url: string) => Promise<void>) {
  const database = `agentsign_019_only_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const admin = new pg.Client({ connectionString: "postgresql://voice_test:voice_cloning_test@127.0.0.1:55438/postgres", ssl: false });
  const url = `postgresql://voice_test:voice_cloning_test@127.0.0.1:55438/${database}`;
  const client = new pg.Client({ connectionString: url, ssl: false });
  let created = false;
  let connected = false;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE ${database}`); created = true;
    await client.connect(); connected = true;
    await client.query(readFileSync("migrations/001_init.sql", "utf8"));
    await client.query("ALTER TABLE agreements ADD COLUMN owner_email TEXT");
    await client.query("CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT NOT NULL)");
    await client.query("INSERT INTO schema_migrations VALUES ($1,$2,'2026-10-04'),('017_product_feedback_data_api_lockdown.sql',NULL,'2026-10-04')", [migration018Name, checksum018]);
    await work(client, url);
  } finally {
    if (connected) await client.end();
    if (created) await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
}
const run = (url: string, apply = false) => migrate019Only({ databaseUrl: url, expected018Checksum: checksum018, apply, localFixture: true });
const leaseExists = async (client: pg.Client) => (await client.query("SELECT to_regclass('public.webhook_delivery_leases') AS relation")).rows[0].relation !== null;
const ledger = async (client: pg.Client) => (await client.query("SELECT * FROM schema_migrations ORDER BY filename")).rows;

test("019-only real PG dry run is read-only and missing prerequisites never bootstrap DDL", { skip: !local }, async () => fixture(async (client, url) => {
  const before = await ledger(client);
  assert.equal((await run(url)).status, "pending");
  assert.equal(await leaseExists(client), false);
  assert.deepEqual(await ledger(client), before);
  await client.query("DROP TABLE schema_migrations");
  await assert.rejects(run(url), /Prerequisite schema mismatch/);
  assert.equal((await client.query("SELECT to_regclass('public.schema_migrations') AS relation")).rows[0].relation, null);
  assert.equal(await leaseExists(client), false);
}));

test("019-only real PG baseline/schema conflicts reject before any migration or checksum backfill", { skip: !local }, async () => fixture(async (client, url) => {
  await client.query("UPDATE schema_migrations SET checksum=NULL WHERE filename=$1", [migration018Name]);
  await assert.rejects(run(url, true), /018 ledger identity/);
  assert.equal(await leaseExists(client), false);
  await client.query("UPDATE schema_migrations SET filename='018_bulk_idempotency.sql',checksum=$1 WHERE filename=$2", [checksum018, migration018Name]);
  await assert.rejects(run(url, true), /018 ledger identity/);
  await client.query("UPDATE schema_migrations SET filename=$1 WHERE filename='018_bulk_idempotency.sql'", [migration018Name]);
  await client.query("ALTER TABLE webhook_deliveries DROP COLUMN next_retry_at");
  await assert.rejects(run(url, true), /webhook_deliveries.next_retry_at/);
  assert.equal(await leaseExists(client), false);
  assert.equal((await ledger(client)).find(row => row.filename.startsWith('017_')).checksum, null);
}));

test("019-only real PG concurrent apply and reapply preserve old rows and unrelated ledger history", { skip: !local }, async () => fixture(async (client, url) => {
  const before = await ledger(client);
  await client.query("INSERT INTO agreements(id,status,recipient_name,recipient_email,document_markdown,document_title,fields_json,signing_token,created_at) VALUES('historical','completed','Fixture','fixture@example.test','# Fixture','Fixture','[]','historical-synthetic','2026-10-04')");
  await client.query("INSERT INTO webhook_deliveries(id,agreement_id,url,payload_json,attempts,next_retry_at) VALUES('historical','historical','https://receiver.example.test','{}',2,'2026-10-04')");
  const historical = (await client.query("SELECT * FROM webhook_deliveries")).rows;
  const results = await Promise.all([run(url, true), run(url, true)]);
  assert.deepEqual((await client.query("SELECT * FROM webhook_deliveries")).rows, historical);
  assert.deepEqual(results.map(result => result.status).sort(), ["already-applied", "pending"]);
  assert.equal(await leaseExists(client), true);
  const after = await ledger(client);
  assert.deepEqual(after.filter(row => row.filename !== migration019Name), before);
  assert.equal(after.find(row => row.filename === migration019Name).checksum, migration019Checksum);
  assert.equal((await run(url)).status, "already-applied");
  assert.equal((await run(url, true)).status, "already-applied");
  assert.deepEqual(await ledger(client), after);
  const cli = await execute(process.execPath, ['--import','tsx','scripts/migrate-019-only.ts','--dry-run','--local-fixture',`--expected-018-sha256=${checksum018}`], { env: { PATH: process.env.PATH, DATABASE_URL: url } });
  assert.equal(JSON.parse(cli.stdout).mode, "read-only");
  assert.equal(JSON.parse(cli.stdout).status, "already-applied");
  assert.doesNotMatch(cli.stdout + cli.stderr, /voice_cloning_test|postgresql:\/\//);
  await client.query("GRANT SELECT ON webhook_delivery_leases TO PUBLIC");
  const publicSelect = async () => (await client.query("SELECT EXISTS(SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid='webhook_delivery_leases'::regclass AND a.grantee=0 AND a.privilege_type='SELECT') AS allowed")).rows[0].allowed;
  await run(url); assert.equal(await publicSelect(), true);
  await run(url, true); assert.equal(await publicSelect(), false);
  await client.query("INSERT INTO agreements(id,status,recipient_name,recipient_email,document_markdown,document_title,fields_json,signing_token,created_at) VALUES('old','completed','Fixture','fixture@example.test','# Fixture','Fixture','[]','synthetic','2026-10-04')");
  await client.query("INSERT INTO webhook_deliveries(id,agreement_id,url,payload_json) VALUES('old','old','https://receiver.example.test','{}')");
  await client.query("INSERT INTO webhook_delivery_leases VALUES('old','synthetic','2999-01-01')");
  await client.query("DELETE FROM webhook_deliveries WHERE id='old'");
  assert.equal((await client.query("SELECT * FROM webhook_delivery_leases")).rowCount, 0);
}));

test("019-only real PG ledger and pre-existing schema conflicts cannot be adopted", { skip: !local }, async () => fixture(async (client, url) => {
  await client.query("INSERT INTO schema_migrations VALUES($1,'wrong','2026-10-04')", [migration019Name]);
  await assert.rejects(run(url, true), /019 ledger/);
  assert.equal(await leaseExists(client), false);
  await client.query("UPDATE schema_migrations SET checksum=$1 WHERE filename=$2", [migration019Checksum, migration019Name]);
  await assert.rejects(run(url, true), /lease schema is absent/);
  await client.query("DELETE FROM schema_migrations WHERE filename=$1", [migration019Name]);
  await client.query("CREATE TABLE webhook_delivery_leases(delivery_id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at TEXT NOT NULL)");
  await assert.rejects(run(url, true), /lease foreign key/);
  assert.equal((await ledger(client)).some(row => row.filename === migration019Name), false);
}));

test("019-only real PG mid-apply failure rolls back table, index, privilege changes and ledger atomically", { skip: !local }, async () => fixture(async (client, url) => {
  const before = await ledger(client);
  await client.query("CREATE FUNCTION fixture_019_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.filename='019_webhook_delivery_leases.sql' THEN RAISE EXCEPTION 'fixture ledger insert failure'; END IF; RETURN NEW; END $$");
  await client.query("CREATE TRIGGER fixture_019_fail BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION fixture_019_fail()");
  await assert.rejects(run(url, true), /fixture ledger insert failure/);
  assert.equal(await leaseExists(client), false);
  assert.equal((await client.query("SELECT to_regclass('public.idx_webhook_delivery_leases_expiry') AS relation")).rows[0].relation, null);
  assert.deepEqual(await ledger(client), before);
  await client.query(readFileSync('migrations/019_webhook_delivery_leases.sql','utf8'));
  await client.query("GRANT SELECT ON webhook_delivery_leases TO PUBLIC");
  await assert.rejects(run(url, true), /fixture ledger insert failure/);
  assert.equal((await client.query("SELECT EXISTS(SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid='webhook_delivery_leases'::regclass AND a.grantee=0 AND a.privilege_type='SELECT') AS allowed")).rows[0].allowed, true);
  await client.query("DROP TRIGGER fixture_019_fail ON schema_migrations");
  assert.equal((await run(url, true)).status, "schema-present-ledger-pending");
}));

test("019-only CLI rejects invalid targets without printing target credentials", async () => {
  try {
    await execute(process.execPath, ['--import','tsx','scripts/migrate-019-only.ts','--dry-run',`--expected-018-sha256=${checksum018}`], { env: { PATH: process.env.PATH, DATABASE_URL: production.replace('synthetic','must-not-print'), DATABASE_CA_CERT: '' } });
    assert.fail('invalid target should fail');
  } catch (error) {
    const failure = error as Error & { stdout: string; stderr: string; code: number };
    assert.equal(failure.code, 1);
    assert.doesNotMatch(failure.stdout + failure.stderr, /must-not-print|postgresql:\/\//);
  }
});
