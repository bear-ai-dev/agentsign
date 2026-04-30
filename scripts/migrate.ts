import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import pg from "pg";

type Target = "sqlite" | "postgres";
type MigrationFile = {
  filename: string;
  sql: string;
  checksum: string;
};

const databaseUrl = process.env.DATABASE_URL?.trim();
const target: Target = databaseUrl ? "postgres" : "sqlite";
const databasePath = process.env.DATABASE_PATH ?? "./agentink.db";
const migrationsDir = join(process.cwd(), "migrations");
const dryRun = process.argv.includes("--dry-run");
const statusOnly = process.argv.includes("--status");
const allowChecksumDrift = process.env.MIGRATION_ALLOW_CHECKSUM_DRIFT === "true";
const migrationLockId = 424242017;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function loadMigrations(): MigrationFile[] {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(migrationsDir, filename), "utf8");
      return { filename, sql, checksum: sha256(sql) };
    });
}

function postgresSsl() {
  if (!databaseUrl) return undefined;
  const sslSetting = (process.env.PGSSLMODE ?? process.env.DATABASE_SSL ?? "").toLowerCase();
  if (sslSetting === "disable" || sslSetting === "false" || sslSetting === "0") return false;

  const hostname = new URL(databaseUrl).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
  return { rejectUnauthorized: false };
}

function normalizePostgresSql(sql: string) {
  return sql
    .replace(/CREATE TABLE (?!IF NOT EXISTS)([a-zA-Z_][a-zA-Z0-9_]*)/g, "CREATE TABLE IF NOT EXISTS $1")
    .replace(/CREATE INDEX (?!IF NOT EXISTS)/g, "CREATE INDEX IF NOT EXISTS ");
}

function ensureSqliteMigrationsTable(db: Database.Database) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT NOT NULL)");
  const columns = new Set(
    db.prepare("PRAGMA table_info(schema_migrations)").all().map((column) => (column as { name: string }).name)
  );
  if (!columns.has("checksum")) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
}

function ensureSqliteCompatibility(db: Database.Database) {
  const agreementExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agreements'").get();
  if (agreementExists) {
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
  }

  db.exec(`CREATE TABLE IF NOT EXISTS agentcontract_api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    last4 TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_id TEXT,
    owner_email TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_owner_email ON agentcontract_api_keys(owner_email);
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_hash ON agentcontract_api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_active ON agentcontract_api_keys(revoked_at) WHERE revoked_at IS NULL;
  `);
}

function migrationStatus(current: { filename: string; checksum: string | null } | undefined, migration: MigrationFile) {
  if (!current) return "pending";
  if (!current.checksum) return "applied-no-checksum";
  if (current.checksum !== migration.checksum) return "checksum-mismatch";
  return "applied";
}

async function migrateSqlite(migrations: MigrationFile[]) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  ensureSqliteMigrationsTable(db);

  try {
    const appliedRows = db.prepare("SELECT filename, checksum FROM schema_migrations").all() as Array<{
      filename: string;
      checksum: string | null;
    }>;
    const applied = new Map(appliedRows.map((row) => [row.filename, row]));

    console.log(`Migration target: sqlite (${databasePath})`);
    for (const migration of migrations) {
      const current = applied.get(migration.filename);
      const status = migrationStatus(current, migration);
      if (statusOnly) {
        console.log(`${migration.filename}: ${status}`);
        continue;
      }
      if (status === "applied") continue;
      if (status === "checksum-mismatch" && !allowChecksumDrift) {
        throw new Error(`Checksum mismatch for applied migration ${migration.filename}. Set MIGRATION_ALLOW_CHECKSUM_DRIFT=true only if you intentionally changed history.`);
      }
      if (status === "applied-no-checksum") {
        db.prepare("UPDATE schema_migrations SET checksum = ? WHERE filename = ?").run(migration.checksum, migration.filename);
        console.log(`Backfilled checksum for ${migration.filename}`);
        continue;
      }
      if (dryRun) {
        console.log(`Pending ${migration.filename}`);
        continue;
      }

      const apply = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES (?, ?, ?)")
          .run(migration.filename, migration.checksum, new Date().toISOString());
      });
      apply();
      console.log(`Applied ${migration.filename}`);
    }

    if (!dryRun && !statusOnly) ensureSqliteCompatibility(db);
  } finally {
    db.close();
  }
}

async function ensurePostgresMigrationsTable(client: pg.PoolClient) {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, checksum TEXT, applied_at TEXT NOT NULL)");
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
}

async function ensurePostgresCompatibility(client: pg.PoolClient) {
  await client.query("ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signed_pdf_base64 TEXT");
  await client.query("ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signed_pdf_sha256 TEXT");
  await client.query("ALTER TABLE agreements ADD COLUMN IF NOT EXISTS signed_pdf_bytes INTEGER");
  await client.query("CREATE INDEX IF NOT EXISTS idx_agreements_signed_pdf_sha256 ON agreements(signed_pdf_sha256) WHERE signed_pdf_sha256 IS NOT NULL");

  await client.query(`CREATE TABLE IF NOT EXISTS agentcontract_api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    last4 TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_id TEXT,
    owner_email TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`);
  await client.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_owner_email ON agentcontract_api_keys(owner_email)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_hash ON agentcontract_api_keys(key_hash)");
  await client.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_active ON agentcontract_api_keys(revoked_at) WHERE revoked_at IS NULL");
}

async function migratePostgres(migrations: MigrationFile[]) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for Postgres migrations");

  const pool = new pg.Pool({ connectionString: databaseUrl, ssl: postgresSsl() });
  const client = await pool.connect();
  try {
    console.log("Migration target: postgres (DATABASE_URL)");
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockId]);
    await ensurePostgresMigrationsTable(client);

    const result = await client.query<{ filename: string; checksum: string | null }>(
      "SELECT filename, checksum FROM schema_migrations"
    );
    const applied = new Map(result.rows.map((row) => [row.filename, row]));

    for (const migration of migrations) {
      const current = applied.get(migration.filename);
      const status = migrationStatus(current, migration);
      if (statusOnly) {
        console.log(`${migration.filename}: ${status}`);
        continue;
      }
      if (status === "applied") continue;
      if (status === "checksum-mismatch" && !allowChecksumDrift) {
        throw new Error(`Checksum mismatch for applied migration ${migration.filename}. Set MIGRATION_ALLOW_CHECKSUM_DRIFT=true only if you intentionally changed history.`);
      }
      if (status === "applied-no-checksum") {
        await client.query("UPDATE schema_migrations SET checksum = $1 WHERE filename = $2", [migration.checksum, migration.filename]);
        console.log(`Backfilled checksum for ${migration.filename}`);
        continue;
      }
      if (dryRun) {
        console.log(`Pending ${migration.filename}`);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '60s'");
        await client.query(normalizePostgresSql(migration.sql));
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES ($1, $2, $3)",
          [migration.filename, migration.checksum, new Date().toISOString()]
        );
        await client.query("COMMIT");
        console.log(`Applied ${migration.filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (!dryRun && !statusOnly) await ensurePostgresCompatibility(client);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [migrationLockId]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function main() {
  if (!existsSync(migrationsDir)) throw new Error(`Missing migrations directory: ${migrationsDir}`);
  const migrations = loadMigrations();
  if (target === "postgres") {
    await migratePostgres(migrations);
  } else {
    await migrateSqlite(migrations);
  }
  console.log(statusOnly ? "Migration status complete" : dryRun ? "Migration dry run complete" : "Migrations complete");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
