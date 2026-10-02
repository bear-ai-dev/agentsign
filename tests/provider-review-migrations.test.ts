import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import Database from "better-sqlite3";

const execute = promisify(execFile);
const migration = "018_bulk_idempotency.sql";

test("bulk idempotency migration upgrades, repeats and rolls back without changing agreements", async () => {
  const db = new Database(":memory:");
  try {
    for (const name of (await readdir("migrations")).filter((name) => name.endsWith(".sql") && name < migration).sort()) db.exec(await readFile(join("migrations", name), "utf8"));
    db.prepare("INSERT INTO agreements (id, status, recipient_name, recipient_email, document_markdown, document_title, fields_json, signing_token, created_at) VALUES ('legacy', 'sent', 'Talent', 'talent@example.test', '# Legacy', 'Legacy', '[]', 'fake-token', '2026-10-02T00:00:00.000Z')").run();
    const before = db.prepare("SELECT * FROM agreements").all();
    const sql = await readFile(join("migrations", migration), "utf8");
    db.exec(sql);
    db.exec(sql);
    db.prepare("INSERT INTO agreement_bulk_requests VALUES ('owner:fixture', 'bulk', 'fake-hash', '2026-10-02')").run();
    assert.throws(() => db.prepare("INSERT INTO agreement_bulk_requests VALUES ('owner:fixture', 'bulk', 'changed', '2026-10-02')").run(), /UNIQUE/);
    assert.deepEqual(db.prepare("SELECT * FROM agreements").all(), before);
    db.exec("DROP TABLE agreement_bulk_requests");
    assert.deepEqual(db.prepare("SELECT * FROM agreements").all(), before);
  } finally { db.close(); }
});

test("SQLite migration runner records bulk idempotency after provider startup installed it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provider-review-migration-"));
  const path = join(directory, "provider.db");
  const db = new Database(path);
  const names = (await readdir("migrations")).filter((name) => name.endsWith(".sql") && name < migration).sort();
  for (const name of names) db.exec(await readFile(join("migrations", name), "utf8"));
  db.exec("CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT NOT NULL)");
  for (const name of names) db.prepare("INSERT INTO schema_migrations VALUES (?, NULL, '2026-10-02')").run(name);
  db.close();
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), DOTENV_CONFIG_PATH: "/dev/null", DATABASE_PATH: path, NODE_ENV: "test", POSTHOG_ENABLED: "false" };
  try {
    await execute(process.execPath, ["--import", "tsx", "-e", "await import('./src/lib/db.ts')"], { env });
    await execute(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], { env });
    const checked = new Database(path);
    try {
      assert.ok(checked.prepare("SELECT checksum FROM schema_migrations WHERE filename = ?").get(migration));
      assert.equal((checked.prepare("SELECT COUNT(*) AS count FROM agreement_bulk_requests").get() as { count: number }).count, 0);
    } finally { checked.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
