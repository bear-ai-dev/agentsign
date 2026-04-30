import "dotenv/config";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const databasePath = process.env.DATABASE_PATH ?? "./agentink.db";
mkdirSync(dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma("foreign_keys = ON");
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");

const migrationsDir = join(process.cwd(), "migrations");
const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

for (const file of files) {
  const applied = db.prepare("SELECT filename FROM schema_migrations WHERE filename = ?").get(file);
  if (applied) continue;

  const sql = readFileSync(join(migrationsDir, file), "utf8");
  const apply = db.transaction(() => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
  });
  apply();
  console.log(`Applied ${file}`);
}

const agreementColumns = new Set(
  db.prepare("PRAGMA table_info(agreements)").all().map((column) => (column as { name: string }).name)
);
for (const [name, type] of [
  ["signed_pdf_base64", "TEXT"],
  ["signed_pdf_sha256", "TEXT"],
  ["signed_pdf_bytes", "INTEGER"]
] as const) {
  if (!agreementColumns.has(name)) {
    db.exec(`ALTER TABLE agreements ADD COLUMN ${name} ${type}`);
    console.log(`Added agreements.${name}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS idx_agreements_signed_pdf_sha256 ON agreements(signed_pdf_sha256) WHERE signed_pdf_sha256 IS NOT NULL");

console.log("Migrations complete");
