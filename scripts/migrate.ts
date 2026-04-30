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

db.exec(`CREATE TABLE IF NOT EXISTS product_feedback (
  id TEXT PRIMARY KEY,
  owner_email TEXT,
  reporter_email TEXT,
  reporter_name TEXT,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  command TEXT,
  message TEXT NOT NULL,
  expected TEXT,
  actual TEXT,
  context_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('open', 'triaged', 'closed')) DEFAULT 'open',
  created_at TEXT NOT NULL
)`);
const feedbackColumns = new Set(
  db.prepare("PRAGMA table_info(product_feedback)").all().map((column) => (column as { name: string }).name)
);
for (const [name, type] of [
  ["owner_email", "TEXT"],
  ["reporter_email", "TEXT"],
  ["reporter_name", "TEXT"],
  ["source", "TEXT"],
  ["category", "TEXT"],
  ["severity", "TEXT"],
  ["command", "TEXT"],
  ["message", "TEXT"],
  ["expected", "TEXT"],
  ["actual", "TEXT"],
  ["context_json", "TEXT"],
  ["status", "TEXT"],
  ["created_at", "TEXT"]
] as const) {
  if (!feedbackColumns.has(name)) {
    db.exec(`ALTER TABLE product_feedback ADD COLUMN ${name} ${type}`);
    console.log(`Added product_feedback.${name}`);
  }
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_product_feedback_created_at ON product_feedback(created_at);
  CREATE INDEX IF NOT EXISTS idx_product_feedback_status ON product_feedback(status);
  CREATE INDEX IF NOT EXISTS idx_product_feedback_owner_email ON product_feedback(owner_email);
  CREATE INDEX IF NOT EXISTS idx_product_feedback_reporter_email ON product_feedback(reporter_email);
`);

console.log("Migrations complete");
