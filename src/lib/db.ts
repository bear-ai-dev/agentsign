import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import pg from "pg";
import { env } from "./env.js";
import type { Agreement, AuditEvent, AgreementStatus } from "./types.js";

mkdirSync(dirname(env.databasePath), { recursive: true });

const usePostgres = Boolean(process.env.DATABASE_URL);
const sqlite = usePostgres ? null : new Database(env.databasePath);
const pool = usePostgres ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

if (sqlite) {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
}

export const dbReady = ensureSchema();

export function nowIso() {
  return new Date().toISOString();
}

export async function run(sql: string, ...params: unknown[]) {
  await dbReady;
  if (pool) {
    await pool.query(toPg(sql), params);
    return;
  }
  sqlite!.prepare(sql).run(...params);
}

export async function runTransaction(statements: Array<{ sql: string; params?: unknown[] }>) {
  await dbReady;
  if (!statements.length) return;

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(toPg(statement.sql), statement.params ?? []);
      }
      await client.query("COMMIT");
      return;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const transaction = sqlite!.transaction((items: Array<{ sql: string; params?: unknown[] }>) => {
    for (const statement of items) {
      sqlite!.prepare(statement.sql).run(...(statement.params ?? []));
    }
  });
  transaction(statements);
}

export async function get<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
  await dbReady;
  if (pool) {
    const result = await pool.query(toPg(sql), params);
    return result.rows[0] as T | undefined;
  }
  return sqlite!.prepare(sql).get(...params) as T | undefined;
}

export async function all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  await dbReady;
  if (pool) {
    const result = await pool.query(toPg(sql), params);
    return result.rows as T[];
  }
  return sqlite!.prepare(sql).all(...params) as T[];
}

export async function addAuditEvent(input: {
  agreementId: string;
  eventType: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  data?: unknown;
}) {
  await run(
    `INSERT INTO audit_events (id, agreement_id, event_type, ip_address, user_agent, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `evt_${nanoid(16)}`,
    input.agreementId,
    input.eventType,
    input.ipAddress ?? null,
    input.userAgent ?? null,
    input.data === undefined ? null : JSON.stringify(input.data),
    nowIso()
  );
}

export async function getAgreement(id: string): Promise<Agreement | undefined> {
  return get<Agreement>("SELECT * FROM agreements WHERE id = ?", id);
}

export async function getAgreementByToken(token: string): Promise<Agreement | undefined> {
  return get<Agreement>("SELECT * FROM agreements WHERE signing_token = ?", token);
}

export async function getAuditEvents(agreementId: string): Promise<AuditEvent[]> {
  return all<AuditEvent>("SELECT * FROM audit_events WHERE agreement_id = ? ORDER BY created_at ASC", agreementId);
}

export async function updateAgreementStatus(id: string, status: AgreementStatus) {
  await run("UPDATE agreements SET status = ? WHERE id = ?", status, id);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function ensureSchema() {
  const exists = usePostgres
    ? await pool!.query("SELECT to_regclass('public.agreements') AS table_name").then((result) => result.rows[0]?.table_name)
    : sqlite!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agreements'").get();
  if (!exists) {
    await applyMigrationFile("001_init.sql");
  }

  await ensureAgreementStorageSchema();
  await ensureApiKeysSchema();
  await applyMigrationFile("003_cli_login_codes.sql");
}

async function ensureAgreementStorageSchema() {
  const columns = [
    ["signed_pdf_base64", "TEXT"],
    ["signed_pdf_sha256", "TEXT"],
    ["signed_pdf_bytes", "INTEGER"]
  ] as const;

  if (pool) {
    for (const [name, type] of columns) {
      await pool.query(`ALTER TABLE agreements ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agreements_signed_pdf_sha256 ON agreements(signed_pdf_sha256) WHERE signed_pdf_sha256 IS NOT NULL");
    return;
  }

  const existing = new Set(
    sqlite!.prepare("PRAGMA table_info(agreements)").all().map((column) => (column as { name: string }).name)
  );
  for (const [name, type] of columns) {
    if (!existing.has(name)) sqlite!.exec(`ALTER TABLE agreements ADD COLUMN ${name} ${type}`);
  }
  sqlite!.exec("CREATE INDEX IF NOT EXISTS idx_agreements_signed_pdf_sha256 ON agreements(signed_pdf_sha256) WHERE signed_pdf_sha256 IS NOT NULL");
}

async function ensureApiKeysSchema() {
  const apiKeyColumns = [
    ["key_hash", "TEXT"],
    ["key_prefix", "TEXT"],
    ["last4", "TEXT"],
    ["name", "TEXT"],
    ["owner_id", "TEXT"],
    ["owner_email", "TEXT"],
    ["created_at", "TEXT"],
    ["last_used_at", "TEXT"],
    ["revoked_at", "TEXT"]
  ] as const;
  const sql = `CREATE TABLE IF NOT EXISTS agentcontract_api_keys (
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
  )`;

  if (pool) {
    await pool.query(sql);
    for (const [name, type] of apiKeyColumns) {
      await pool.query(`ALTER TABLE agentcontract_api_keys ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_owner_email ON agentcontract_api_keys(owner_email)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_hash ON agentcontract_api_keys(key_hash)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_active ON agentcontract_api_keys(revoked_at) WHERE revoked_at IS NULL");
    return;
  }

  sqlite!.exec(sql);
  const columns = new Set(
    sqlite!.prepare("PRAGMA table_info(agentcontract_api_keys)").all().map((column) => (column as { name: string }).name)
  );
  for (const [name, type] of apiKeyColumns) {
    if (!columns.has(name)) sqlite!.exec(`ALTER TABLE agentcontract_api_keys ADD COLUMN ${name} ${type}`);
  }
  sqlite!.exec(`
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_owner_email ON agentcontract_api_keys(owner_email);
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_hash ON agentcontract_api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_agentcontract_api_keys_active ON agentcontract_api_keys(revoked_at) WHERE revoked_at IS NULL;
  `);
}

async function applyMigrationFile(filename: string) {
  const migrationPath = join(process.cwd(), "migrations", filename);
  if (!existsSync(migrationPath)) {
    throw new Error(`Missing migration file: ${migrationPath}`);
  }
  let sql = readFileSync(migrationPath, "utf8");
  if (usePostgres) {
    sql = sql
      .replaceAll("CREATE TABLE agreements", "CREATE TABLE IF NOT EXISTS agreements")
      .replaceAll("CREATE TABLE audit_events", "CREATE TABLE IF NOT EXISTS audit_events")
      .replaceAll("CREATE TABLE webhook_deliveries", "CREATE TABLE IF NOT EXISTS webhook_deliveries")
      .replaceAll("CREATE TABLE api_keys", "CREATE TABLE IF NOT EXISTS api_keys")
      .replaceAll("CREATE TABLE cli_login_codes", "CREATE TABLE IF NOT EXISTS cli_login_codes")
      .replace(/CREATE INDEX (?!IF NOT EXISTS)/g, "CREATE INDEX IF NOT EXISTS ");
    await pool!.query(sql);
  } else {
    sqlite!.exec(sql);
  }
}

function toPg(sql: string) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
