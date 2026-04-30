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

console.log("Migrations complete");
