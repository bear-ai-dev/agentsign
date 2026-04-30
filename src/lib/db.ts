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

  await applyMigrationFile("002_api_keys.sql");
  await applyMigrationFile("003_cli_login_codes.sql");
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
