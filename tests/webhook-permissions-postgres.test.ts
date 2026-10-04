import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { webhookLeasePrivilegesSql } from "../src/lib/webhookLeaseSchema.js";

const execute = promisify(execFile);
const pgBin = process.env.PROVIDER_TEST_PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const available = existsSync(join(pgBin, "initdb"));
const localEnvironment = { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TMPDIR: tmpdir() };

test("019 PostgreSQL row permissions allow service_role and deny PUBLIC, anon and authenticated despite permissive defaults", { skip: !available, timeout: 45_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentsign-permissions-"));
  const portServer = createServer();
  await new Promise<void>(resolve => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  let started = false;
  let client: pg.Client | undefined;
  try {
    await execute(join(pgBin, "initdb"), ["-D", join(directory, "data"), "-U", "fixture_owner", "-A", "trust", "--no-locale"], { env: localEnvironment });
    await execute(join(pgBin, "pg_ctl"), ["-D", join(directory, "data"), "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory} -c fsync=off`, "-w", "start"], { env: localEnvironment });
    started = true;
    client = new pg.Client({ connectionString: `postgresql://fixture_owner@127.0.0.1:${port}/postgres`, ssl: false });
    await client.connect();
    for (const role of ["anon", "authenticated", "service_role"]) await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(await readFile("migrations/001_init.sql", "utf8"));
    await client.query("INSERT INTO agreements (id, status, recipient_name, recipient_email, document_markdown, document_title, fields_json, signing_token, created_at) VALUES ('fixture', 'completed', 'Talent', 'talent@example.test', '# Fixture', 'Fixture', '[]', 'fixture-token', '2026-01-01')");
    await client.query("INSERT INTO webhook_deliveries (id, agreement_id, url, payload_json) VALUES ('delivery', 'fixture', 'https://receiver.example.test', '{}')");
    await client.query("ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC, anon, authenticated");
    await client.query("BEGIN");
    await client.query(await readFile("migrations/019_webhook_delivery_leases.sql", "utf8"));
    await client.query(webhookLeasePrivilegesSql);
    await client.query("COMMIT");
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.equal((await client.query("SELECT has_table_privilege($1, 'webhook_delivery_leases', $2) AS allowed", [role, privilege])).rows[0].allowed, false);
      await client.query(`SET ROLE ${role}`);
      await assert.rejects(client.query("SELECT * FROM webhook_delivery_leases"), { code: "42501" });
      await client.query("RESET ROLE");
    }
    const publicGrants = await client.query("SELECT 1 FROM pg_class, LATERAL aclexplode(relacl) acl WHERE relname = 'webhook_delivery_leases' AND acl.grantee = 0");
    assert.equal(publicGrants.rowCount, 0);
    await client.query("SET ROLE service_role");
    await client.query("INSERT INTO webhook_delivery_leases VALUES ('delivery', 'fixture-claim', '2999-01-01')");
    assert.equal((await client.query("SELECT token FROM webhook_delivery_leases")).rows[0].token, "fixture-claim");
    assert.equal((await client.query("UPDATE webhook_delivery_leases SET expires_at = '2999-02-01' WHERE delivery_id = 'delivery'")).rowCount, 1);
    assert.equal((await client.query("DELETE FROM webhook_delivery_leases WHERE delivery_id = 'delivery'")).rowCount, 1);
    await assert.rejects(client.query("DROP TABLE webhook_delivery_leases"), { code: "42501" });
    await client.query("RESET ROLE");
    assert.equal((await client.query("SELECT id FROM webhook_deliveries")).rows[0].id, "delivery");
  } finally {
    await client?.end();
    if (started) await execute(join(pgBin, "pg_ctl"), ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"], { env: localEnvironment });
    await rm(directory, { recursive: true, force: true });
  }
});
