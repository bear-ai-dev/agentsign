import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";
import pg from "pg";

const execute = promisify(execFile);
const migration = await readFile("migrations/019_webhook_delivery_leases.sql", "utf8");
const localEnvironment = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/dev/null", NODE_ENV: "test", POSTHOG_ENABLED: "false", RESEND_API_KEY: "", WORKOS_API_KEY: "", WORKOS_COOKIE_PASSWORD: "fixture-cookie-password", AGENTCONTRACT_API_KEY: "fixture-api-key" };

for (const postgres of [false, true]) test(`${postgres ? "PostgreSQL" : "SQLite"} real cross-process leases, crash recovery, stale receipts and portable rollback`, { skip: postgres && process.env.AGENTSIGN_LOCAL_PG_TEST !== "true", timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentsign-durable-"));
  const databaseName = `agentsign_lease_${process.pid}_${Date.now()}`;
  let createdDatabase = false;
  let admin: pg.Client | undefined;
  let client: pg.Client | undefined;
  let sqlite: Database.Database | undefined;
  const databaseUrl = postgres ? `postgresql://voice_test:voice_cloning_test@127.0.0.1:55438/${databaseName}` : "";
  const environment = { ...localEnvironment, CRON_SECRET: "fixture-cron-secret", DATABASE_URL: databaseUrl, DATABASE_PATH: join(directory, "fixture.db"), PDF_OUTPUT_DIR: join(directory, "pdfs") };
  const child = (input: Record<string, unknown>) => execute(process.execPath, ["--import", "tsx", "tests/fixtures/durable-webhook-child.ts", JSON.stringify(input)], { env: environment });
  const query = async (sql: string, params: unknown[] = []) => {
    if (client) { let i = 0; return (await client.query(sql.replace(/\?/g, () => `$${++i}`), params)).rows; }
    const statement = sqlite!.prepare(sql);
    return statement.reader ? statement.all(...params) : (statement.run(...params), []);
  };
  try {
    if (postgres) {
      admin = new pg.Client({ connectionString: "postgresql://voice_test:voice_cloning_test@127.0.0.1:55438/postgres", ssl: false });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${databaseName}`);
      createdDatabase = true;
    }
    await child({ action: "claim", id: "absent" });
    if (postgres) { client = new pg.Client({ connectionString: databaseUrl, ssl: false }); await client.connect(); }
    else { sqlite = new Database(environment.DATABASE_PATH); sqlite.pragma("foreign_keys = ON"); }
    await query("INSERT INTO agreements (id, status, recipient_name, recipient_email, document_markdown, document_title, fields_json, signing_token, created_at, webhook_secret) VALUES ('fixture', 'completed', 'Talent', 'talent@example.test', '# Fixture', 'Fixture', '[]', 'fixture-token', '2026-01-01', 'fixture-secret')");
    const insert = (id: string) => query("INSERT INTO webhook_deliveries (id, agreement_id, url, payload_json, attempts, next_retry_at) VALUES (?, 'fixture', 'https://receiver.example.test', '{\"event\":\"agreement.completed\"}', 0, '2026-01-01T00:00:00.000Z')", [id]);
    await insert("claim-race");
    const claims = await Promise.allSettled(Array.from({ length: 6 }, () => child({ action: "claim", id: "claim-race" })));
    for (const result of claims) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : "");
    const winners = claims.flatMap(result => result.status === "fulfilled" ? [JSON.parse(result.value.stdout).token] : []).filter(Boolean);
    assert.equal(winners.length, 1);
    await query("UPDATE webhook_delivery_leases SET expires_at = '2000-01-01' WHERE delivery_id = 'claim-race'");
    const replacement = JSON.parse((await child({ action: "claim", id: "claim-race" })).stdout).token;
    assert.ok(replacement && replacement !== winners[0]);
    await child({ action: "receipt", id: "claim-race", token: winners[0] });
    assert.equal((await query("SELECT delivered_at FROM webhook_deliveries WHERE id = 'claim-race'") as { delivered_at: string | null }[])[0].delivered_at, null);
    assert.equal((await query("SELECT token FROM webhook_delivery_leases WHERE delivery_id = 'claim-race'") as { token: string }[])[0].token, replacement);
    await child({ action: "receipt", id: "claim-race", token: replacement });
    assert.ok((await query("SELECT delivered_at FROM webhook_deliveries WHERE id = 'claim-race'") as { delivered_at: string }[])[0].delivered_at);
    assert.equal(JSON.parse((await child({ action: "claim", id: "claim-race" })).stdout).token, null);
    await insert("deliver-race");
    const marker = join(directory, "posts.jsonl");
    const deliveries = await Promise.allSettled(Array.from({ length: 6 }, () => child({ action: "deliver", id: "deliver-race", marker })));
    for (const result of deliveries) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : "");
    const posts = (await readFile(marker, "utf8")).trim().split("\n");
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0]).headers["X-AgentInk-Delivery-Id"], "deliver-race");
    await insert("crash");
    await assert.rejects(child({ action: "deliver", id: "crash", marker, crash: true }), { code: 17 });
    await query("UPDATE webhook_delivery_leases SET expires_at = '2000-01-01' WHERE delivery_id = 'crash'");
    await child({ action: "deliver", id: "crash", marker });
    const recoveredPosts = (await readFile(marker, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(recoveredPosts.length, 3);
    assert.equal(recoveredPosts[1].headers["X-AgentInk-Delivery-Id"], "crash");
    assert.deepEqual(recoveredPosts[1], recoveredPosts[2]);
    if (postgres) {
      const barrier = join(directory, "contender-go");
      const ready = join(directory, "contender-ready");
      const contender = child({ action: "deliver", id: "blocked-receipt", marker, waitFor: barrier, ready });
      const readyDeadline = Date.now() + 10_000;
      let prepared = false;
      while (Date.now() < readyDeadline) {
        try { await readFile(ready); prepared = true; break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(prepared, "the contender must initialize before the receipt locks schema rows");
      await insert("blocked-receipt");
      const blockedToken = JSON.parse((await child({ action: "claim", id: "blocked-receipt" })).stdout).token;
      const expiry = Date.now() + 4_000;
      await query("UPDATE webhook_delivery_leases SET expires_at = ? WHERE delivery_id = 'blocked-receipt'", [new Date(expiry).toISOString()]);
      const locker = new pg.Client({ connectionString: databaseUrl, ssl: false });
      await locker.connect();
      let receipt: ReturnType<typeof child> | undefined;
      try {
        await locker.query("BEGIN");
        await locker.query("SELECT id FROM webhook_deliveries WHERE id = 'blocked-receipt' FOR UPDATE");
        const pid = (await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        receipt = child({ action: "receipt", id: "blocked-receipt", token: blockedToken });
        let blocked = false;
        while (Date.now() < expiry - 100) {
          const rows = await query("SELECT 1 FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))", [pid]);
          if (rows.length) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(blocked, "the real receipt must wait on the delivery row while retaining its lease lock");
        await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry - Date.now() + 100)));
        await writeFile(barrier, "go");
        const deadline = Date.now() + 5_000;
        let leaseBlocked = false;
        while (Date.now() < deadline) {
          const rows = await query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%INSERT INTO webhook_delivery_leases%' AND cardinality(pg_blocking_pids(pid)) > 0");
          if (rows.length) { leaseBlocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(leaseBlocked, "takeover must wait for the real receipt's lease lock");
        await locker.query("COMMIT");
        await Promise.all([receipt, contender]);
        assert.ok((await query("SELECT delivered_at FROM webhook_deliveries WHERE id = 'blocked-receipt'") as { delivered_at: string }[])[0].delivered_at);
        assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 3);
        assert.equal((await query("SELECT token FROM webhook_delivery_leases WHERE delivery_id = 'blocked-receipt'")).length, 0);
      } finally {
        await locker.query("ROLLBACK");
        await writeFile(barrier, "go");
        await locker.end();
        await Promise.allSettled([receipt, contender].filter(Boolean));
      }
    }
    await insert("cron-race");
    const cronRuns = await Promise.allSettled(Array.from({ length: 6 }, () => child({ action: "cron", id: "cron-race", marker })));
    for (const result of cronRuns) {
      assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : "");
      if (result.status === "fulfilled") assert.equal(JSON.parse(result.value.stdout).status, 200);
    }
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 4);
    await insert("cron-unauthorized");
    assert.equal(JSON.parse((await child({ action: "cron", id: "cron-unauthorized", marker, authorization: "Bearer wrong" })).stdout).status, 401);
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 4);
    await insert("exhausted");
    await query("UPDATE webhook_deliveries SET attempts = 5, next_retry_at = NULL WHERE id = 'exhausted'");
    assert.equal(JSON.parse((await child({ action: "claim", id: "exhausted" })).stdout).token, null);
    await insert("future");
    await query("UPDATE webhook_deliveries SET next_retry_at = '2999-01-01' WHERE id = 'future'");
    assert.equal(JSON.parse((await child({ action: "claim", id: "future" })).stdout).token, null);
    await query("CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT NOT NULL)");
    for (const name of (await readdir("migrations")).filter(name => name.endsWith(".sql") && name < "019_webhook_delivery_leases.sql")) await query("INSERT INTO schema_migrations VALUES (?, NULL, '2026-01-01')", [name]);
    await execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { env: environment });
    const recorded = await query("SELECT checksum FROM schema_migrations WHERE filename = '019_webhook_delivery_leases.sql'") as { checksum: string }[];
    assert.match(recorded[0].checksum, /^[a-f0-9]{64}$/);
    const before = await query("SELECT * FROM webhook_deliveries ORDER BY id");
    if (client) await client.query(migration); else sqlite!.exec(migration);
    await query("DROP TABLE webhook_delivery_leases");
    assert.deepEqual(await query("SELECT * FROM webhook_deliveries ORDER BY id"), before);
    await query("INSERT INTO webhook_deliveries (id, agreement_id, url, payload_json) VALUES ('old-caller', 'fixture', 'https://receiver.example.test', '{}')");
    if (client) await client.query(migration); else sqlite!.exec(migration);
    assert.equal((await query("SELECT * FROM webhook_delivery_leases")).length, 0);
  } finally {
    sqlite?.close();
    await client?.end();
    if (admin) { if (createdDatabase) await admin.query(`DROP DATABASE ${databaseName}`); await admin.end(); }
    await rm(directory, { recursive: true, force: true });
  }
});
