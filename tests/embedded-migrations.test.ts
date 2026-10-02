import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";

const execute = promisify(execFile);
const migration = "017_embedded_signing.sql";

async function historicalDatabase(path: string) {
  const db = new Database(path);
  for (const name of (await readdir("migrations")).filter((name) => name.endsWith(".sql") && name < migration).sort()) db.exec(await readFile(join("migrations", name), "utf8"));
  db.prepare("INSERT INTO agreements (id, status, recipient_name, recipient_email, document_markdown, document_title, fields_json, signing_token, created_at) VALUES ('legacy', 'sent', 'Talent', 'talent@example.test', '# Legacy', 'Legacy', '[]', 'inert-test-token', '2026-10-02T00:00:00.000Z')").run();
  return db;
}

test("embedded migration upgrades and rolls back an existing local database preserving hosted rows", async () => {
  const db = await historicalDatabase(":memory:");
  db.exec(await readFile(join("migrations", migration), "utf8"));
  assert.equal((db.prepare("SELECT signing_mode FROM agreements WHERE id = 'legacy'").get() as { signing_mode: string }).signing_mode, "hosted");
  db.exec("DROP TABLE agreement_signing_sessions; DROP INDEX idx_agreements_idempotency");
  for (const column of ["signing_mode", "allowed_parent_origins_json", "prefill_fields_json", "idempotency_scope", "idempotency_key", "creation_request_sha256"]) db.exec(`ALTER TABLE agreements DROP COLUMN ${column}`);
  assert.equal((db.prepare("SELECT signing_token FROM agreements WHERE id = 'legacy'").get() as { signing_token: string }).signing_token, "inert-test-token");
  db.close();
});

test("migration runner records the embedded migration after startup already installed its schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-migration-"));
  const path = join(directory, "provider.db");
  const db = await historicalDatabase(path);
  db.exec("CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT NOT NULL)");
  for (const name of (await readdir("migrations")).filter((name) => name.endsWith(".sql") && name < migration)) db.prepare("INSERT INTO schema_migrations VALUES (?, NULL, '2026-10-02T00:00:00.000Z')").run(name);
  db.close();
  const env = { ...process.env, DOTENV_CONFIG_PATH: "/dev/null", DATABASE_PATH: path, DATABASE_URL: "", NODE_ENV: "test", VERCEL: "" };
  try {
    await execute(process.execPath, ["--import", "tsx", "-e", "await import('./src/lib/db.ts')"], { env });
    await execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { env });
    const checked = new Database(path);
    assert.ok(checked.prepare("SELECT checksum FROM schema_migrations WHERE filename = ?").get(migration));
    checked.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
