import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { before, after } from "node:test";
import pg from "pg";
import puppeteer from "puppeteer-core";
import { setup, cleanup, created, db, sessionPath, submit, sourcePdf, request, headers, bulk, payload } from "./fixtures/provider-review.js";

const execute = promisify(execFile);
const pgBin = process.env.PROVIDER_TEST_PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const available = existsSync(join(pgBin, "initdb"));
const localEnvironment = { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TMPDIR: tmpdir() };
let cluster = "";
let databaseUrl = "";
let started = false;
const pools: pg.Pool[] = [];

before(async () => {
  if (!available) return;
  cluster = await mkdtemp(join(tmpdir(), "provider-review-pg-"));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await execute(join(pgBin, "initdb"), ["-D", join(cluster, "data"), "-U", "provider_fixture", "-A", "trust", "--no-locale"], { env: localEnvironment });
  await execute(join(pgBin, "pg_ctl"), ["-D", join(cluster, "data"), "-l", join(cluster, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${cluster} -c fsync=off`, "-w", "start"], { env: localEnvironment });
  started = true;
  const admin = new pg.Client({ connectionString: `postgresql://provider_fixture@127.0.0.1:${port}/postgres`, ssl: false });
  await admin.connect();
  try { await admin.query("CREATE DATABASE provider_review"); } finally { await admin.end(); }
  databaseUrl = `postgresql://provider_fixture@127.0.0.1:${port}/provider_review`;
  const OriginalPool = pg.Pool;
  pg.Pool = class extends OriginalPool {
    constructor(options: pg.PoolConfig) { super(options); pools.push(this); }
  };
  try { await setup(databaseUrl); } finally { pg.Pool = OriginalPool; }
});

test("PostgreSQL concurrent bulk retries bind the full request and changed retries return 409", { skip: !available }, async () => {
  const body = { ...payload(), recipients: [payload().recipient, { name: "Second", email: "second@example.test" }], idempotency_key: "postgres-bulk" };
  const responses = await Promise.all(Array.from({ length: 4 }, () => bulk(body)));
  for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
  const results = await Promise.all(responses.map((response) => response.json() as Promise<{ agreements: Array<{ id: string }> }>));
  for (const result of results) assert.deepEqual(result.agreements.map((item) => item.id), results[0].agreements.map((item) => item.id));
  assert.equal((await bulk({ ...body, recipients: [...body.recipients, { name: "Third", email: "third@example.test" }] })).status, 409);
  for (const item of results[0].agreements) assert.equal((await db.getAuditEvents(item.id)).filter((event) => event.event_type === "created").length, 1);
});

test("PostgreSQL bulk migration upgrades and rolls back and the runner accepts startup schema", { skip: !available }, async () => {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    const before = await client.query("SELECT id, status, signing_mode FROM agreements ORDER BY id");
    await client.query("BEGIN");
    await client.query("DROP TABLE agreement_bulk_requests");
    const sql = await readFile("migrations/018_bulk_idempotency.sql", "utf8");
    await client.query(sql);
    await client.query(sql);
    await client.query("DROP TABLE agreement_bulk_requests");
    assert.deepEqual((await client.query("SELECT id, status, signing_mode FROM agreements ORDER BY id")).rows, before.rows);
    await client.query("ROLLBACK");
    await client.query("CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT NOT NULL)");
    for (const name of (await readdir("migrations")).filter((name) => name.endsWith(".sql") && name < "017_embedded_signing.sql")) await client.query("INSERT INTO schema_migrations VALUES ($1, NULL, $2)", [name, new Date().toISOString()]);
    await execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { env: { ...localEnvironment, HOME: process.env.HOME, DATABASE_URL: databaseUrl, DOTENV_CONFIG_PATH: "/dev/null", NODE_ENV: "test", POSTHOG_ENABLED: "false" } });
    assert.equal((await client.query("SELECT COUNT(*) AS count FROM schema_migrations WHERE filename IN ('017_embedded_signing.sql', '018_bulk_idempotency.sql') AND checksum IS NOT NULL")).rows[0].count, "2");
  } finally { await client.query("ROLLBACK"); await client.end(); }
});

after(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  if (started) await execute(join(pgBin, "pg_ctl"), ["-D", join(cluster, "data"), "-m", "immediate", "-w", "stop"], { env: localEnvironment });
  if (databaseUrl) await cleanup();
  if (cluster) await rm(cluster, { recursive: true, force: true });
});

for (const partial of [false, true]) test(`real PostgreSQL row lock crossing a fixed session deadline refuses ${partial ? "partial signature" : "completion"}`, { skip: !available, timeout: 90_000 }, async (t) => {
  const agreement = await created(partial ? { fields: [{ id: "signature", label: "Talent", type: "signature", required: true }, { id: "client", label: "Client", type: "signature", signerRole: "sender", required: true }], sender_email: "client@example.test" } : { document_pdf_base64: sourcePdf.toString("base64") });
  const path = await sessionPath(agreement.id);
  const browser = partial ? undefined : await puppeteer.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  if (browser) t.mock.method(puppeteer, "launch", async () => browser);
  const deadline = new Date(Date.now() + (partial ? 8_000 : 20_000)).toISOString();
  await db.run("UPDATE agreement_signing_sessions SET expires_at = ? WHERE agreement_id = ?", deadline, agreement.id);
  const locker = new pg.Client({ connectionString: databaseUrl, ssl: false });
  const observer = new pg.Client({ connectionString: databaseUrl, ssl: false });
  await locker.connect();
  await observer.connect();
  let pending: Promise<Response> | undefined;
  try {
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM agreements WHERE id = $1 FOR UPDATE", [agreement.id]);
    const { rows: [{ pid }] } = await locker.query("SELECT pg_backend_pid() AS pid");
    const submission = submit(path);
    pending = submission;
    let blocked = false;
    while (Date.now() < Date.parse(deadline) - 100) {
      const result = await observer.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [pid]);
      if (result.rowCount) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(blocked, "the signing transaction must wait on the real agreement lock before expiry");
    assert.ok(Date.now() < Date.parse(deadline));
    const stored = await observer.query("SELECT expires_at FROM agreement_signing_sessions WHERE agreement_id = $1", [agreement.id]);
    assert.equal(stored.rows[0].expires_at, deadline);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(deadline) - Date.now() + 100)));
    await locker.query("COMMIT");
    const response = await submission;
    assert.equal(response.status, 409, await response.clone().text());
    const unchanged = (await db.getAgreement(agreement.id))!;
    assert.equal(unchanged.status, "sent");
    assert.equal(unchanged.signed_fields_json, null);
    assert.equal(unchanged.signed_pdf_base64, null);
    const events = await db.getAuditEvents(agreement.id);
    assert.equal(events.filter((event) => ["signed", "completed"].includes(event.event_type)).length, 0);
    assert.equal((await request(`/v1/agreements/${agreement.id}/documents/signed`, { headers: headers() })).status, 409);
  } finally {
    await locker.query("ROLLBACK");
    await locker.end();
    if (pending) await pending;
    await observer.end();
    if (browser) await browser.close();
  }
});
